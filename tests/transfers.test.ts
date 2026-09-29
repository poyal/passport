import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { Files, LocalAdapter, Reservations } from "../src/main/files";
import { Transfers, isWithin } from "../src/main/transfers";
import type { Store } from "../src/main/store";
import type { TransferJob } from "../src/shared/model";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});
async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "passport-transfer-"));
  dirs.push(dir);
  await fs.mkdir(path.join(dir, "in"));
  await fs.mkdir(path.join(dir, "out"));
  const files = new Files(
    { read: () => ({ hosts: [] }) } as unknown as Store,
    async () => true,
  );
  const a = new LocalAdapter(),
    b = new LocalAdapter();
  files.adapters.set(a.endpoint.id, a);
  files.adapters.set(b.endpoint.id, b);
  const transfers = new Transfers(files, () => {});
  return { dir, files, a, b, transfers };
}
async function completed(manager: Transfers, id: string): Promise<TransferJob> {
  for (let n = 0; n < 1000; n++) {
    const j = manager.jobs.get(id)!;
    if (!["queued", "running"].includes(j.state)) return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timeout");
}
describe("streaming transfers", () => {
  it("copies a directory byte-for-byte and skips symlink recursion", async () => {
    const { dir, a, b, transfers } = await setup();
    const data = randomBytes(1024 * 1024 * 4);
    await fs.writeFile(path.join(dir, "in", "한글 공백.bin"), data);
    await fs.symlink(path.join(dir, "in"), path.join(dir, "in", "cycle"));
    const j = transfers.add({
      source: a.endpoint.id,
      destination: b.endpoint.id,
      paths: [path.join(dir, "in")],
      target: path.join(dir, "out"),
      conflict: "skip",
    });
    const done = await completed(transfers, j.id);
    expect(done.state).toBe("completed");
    expect(done.skipped).toBe(1);
    expect(
      createHash("sha256")
        .update(await fs.readFile(path.join(dir, "out", "in", "한글 공백.bin")))
        .digest("hex"),
    ).toBe(createHash("sha256").update(data).digest("hex"));
    expect(
      (await fs.readdir(path.join(dir, "out", "in"))).some((n) =>
        n.endsWith(".part"),
      ),
    ).toBe(false);
  });
  it("rejects self-subtree copies before creating folders", async () => {
    const { dir, a, b, transfers } = await setup();
    const j = transfers.add({
      source: a.endpoint.id,
      destination: b.endpoint.id,
      paths: [path.join(dir, "in")],
      target: path.join(dir, "in"),
      conflict: "overwrite",
    });
    expect((await completed(transfers, j.id)).state).toBe("error");
    expect(await fs.readdir(path.join(dir, "in"))).toEqual([]);
  });
  it("honors skip, rename, and overwrite without leaving temporary files", async () => {
    const { dir, a, b, transfers } = await setup();
    const p = path.join(dir, "in", "test");
    await fs.writeFile(p, "new");
    await fs.writeFile(path.join(dir, "out", "test"), "old");
    for (const conflict of ["skip", "rename", "overwrite"] as const) {
      const j = transfers.add({
        source: a.endpoint.id,
        destination: b.endpoint.id,
        paths: [p],
        target: path.join(dir, "out"),
        conflict,
      });
      expect((await completed(transfers, j.id)).state).toBe("completed");
    }
    expect(await fs.readFile(path.join(dir, "out", "test"), "utf8")).toBe(
      "new",
    );
    expect(await fs.readFile(path.join(dir, "out", "test (1)"), "utf8")).toBe(
      "new",
    );
    expect(await fs.readdir(path.join(dir, "out"))).toEqual([
      "test",
      "test (1)",
    ]);
  });
  it("does not follow a destination symlink", async () => {
    const { dir, a, b, transfers } = await setup();
    await fs.writeFile(path.join(dir, "in", "file"), "new");
    await fs.writeFile(path.join(dir, "outside"), "keep");
    await fs.symlink(path.join(dir, "outside"), path.join(dir, "out", "file"));
    const j = transfers.add({
      source: a.endpoint.id,
      destination: b.endpoint.id,
      paths: [path.join(dir, "in", "file")],
      target: path.join(dir, "out"),
      conflict: "overwrite",
    });
    expect((await completed(transfers, j.id)).state).toBe("error");
    expect(await fs.readFile(path.join(dir, "outside"), "utf8")).toBe("keep");
  });
  it("cancels in-flight work and removes its temporary file", async () => {
    const { dir, a, b, transfers } = await setup();
    const p = path.join(dir, "in", "large");
    const fd = await fs.open(p, "w");
    await fd.truncate(256 * 1024 * 1024);
    await fd.close();
    const j = transfers.add({
      source: a.endpoint.id,
      destination: b.endpoint.id,
      paths: [p],
      target: path.join(dir, "out"),
      conflict: "skip",
    });
    setTimeout(() => transfers.cancel(j.id), 10);
    const done = await completed(transfers, j.id);
    expect(done.state).toBe("cancelled");
    for (let n = 0; n < 100 && transfers.controllers.has(j.id); n++)
      await new Promise((r) => setTimeout(r, 10));
    expect(await fs.readdir(path.join(dir, "out"))).toEqual([]);
  });
  it("retries failed work through a replacement connection", async () => {
    const { dir, files, a, b, transfers } = await setup();
    const source = path.join(dir, "in", "retry.txt");
    await fs.writeFile(source, "재연결 후 전송");
    a.download = async () => {
      throw new Error("연결 끊김");
    };
    const first = transfers.add({
      source: a.endpoint.id,
      destination: b.endpoint.id,
      paths: [source],
      target: path.join(dir, "out"),
      conflict: "skip",
    });
    expect((await completed(transfers, first.id)).state).toBe("error");
    const replacement = new LocalAdapter();
    files.adapters.set(replacement.endpoint.id, replacement);
    transfers.rebind(a.endpoint.id, replacement.endpoint.id);
    await files.close(a.endpoint.id);
    const retried = transfers.retry(first.id);
    expect((await completed(transfers, retried.id)).state).toBe("completed");
    expect(await fs.readFile(path.join(dir, "out", "retry.txt"), "utf8")).toBe(
      "재연결 후 전송",
    );
    expect(await fs.readdir(path.join(dir, "out"))).toEqual(["retry.txt"]);
    files.closeAll();
  });
});
describe("endpoint reservations", () => {
  it("serializes opposite-direction work without deadlock", async () => {
    const locks = new Reservations();
    let active = 0,
      max = 0;
    const job = () => {
      active++;
      max = Math.max(active, max);
      return new Promise((r) => setTimeout(r, 10)).then(() => {
        active--;
      });
    };
    await Promise.all([
      locks.with(["a", "b"], job),
      locks.with(["b", "a"], job),
    ]);
    expect(max).toBe(1);
  });
  it("compares directory boundaries, not just prefixes", () => {
    expect(isWithin("/root/a", "/root/ab")).toBe(false);
    expect(isWithin("C:\\Root", "c:\\root\\a", true)).toBe(true);
  });
});

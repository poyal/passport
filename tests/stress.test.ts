import { it, expect } from "vitest";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { Files, LocalAdapter } from "../src/main/files";
import { Transfers } from "../src/main/transfers";
import type { Store } from "../src/main/store";
const enabled = process.env.PASSPORT_STRESS === "1";
async function hash(file: string) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}
it.skipIf(!enabled)(
  "4 GiB transfer remains bounded and 10,000 small files preserve contents",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "passport-stress-"));
    const files = new Files(
      { read: () => ({ hosts: [] }) } as unknown as Store,
      async () => false,
    );
    const a = new LocalAdapter(),
      b = new LocalAdapter();
    files.adapters.set(a.endpoint.id, a);
    files.adapters.set(b.endpoint.id, b);
    const transfers = new Transfers(files, () => {});
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const sample = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 25);
    try {
      await fs.mkdir(path.join(root, "out"));
      const source = path.join(root, "large.bin"),
        fd = await fs.open(source, "w");
      await fd.truncate(4 * 1024 ** 3);
      await fd.close();
      const wait = async (id: string) => {
        for (let n = 0; n < 30000; n++) {
          const job = transfers.jobs.get(id)!;
          if (!["queued", "running"].includes(job.state)) {
            expect(job.error).toBeUndefined();
            expect(job.state).toBe("completed");
            return;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("stress timeout");
      };
      await wait(
        transfers.add({
          source: a.endpoint.id,
          destination: b.endpoint.id,
          paths: [source],
          target: path.join(root, "out"),
          conflict: "skip",
        }).id,
      );
      expect((await fs.stat(path.join(root, "out", "large.bin"))).size).toBe(
        4 * 1024 ** 3,
      );
      expect(await hash(source)).toBe(
        await hash(path.join(root, "out", "large.bin")),
      );
      expect(peak - baseline).toBeLessThan(512 * 1024 ** 2);
      await fs.mkdir(path.join(root, "many"));
      for (let i = 0; i < 10000; i++)
        await fs.writeFile(path.join(root, "many", `${i}.txt`), `file ${i}`);
      await wait(
        transfers.add({
          source: a.endpoint.id,
          destination: b.endpoint.id,
          paths: [path.join(root, "many")],
          target: path.join(root, "out"),
          conflict: "skip",
        }).id,
      );
      expect(await fs.readdir(path.join(root, "out", "many"))).toHaveLength(
        10000,
      );
      for (const i of [0, 4999, 9999])
        expect(
          await fs.readFile(path.join(root, "out", "many", `${i}.txt`), "utf8"),
        ).toBe(`file ${i}`);
      console.log(
        JSON.stringify({
          stress: "4GiB + 10000 files",
          baselineRSS: baseline,
          peakRSS: peak,
          growthMiB: Math.round((peak - baseline) / 1024 ** 2),
        }),
      );
    } finally {
      clearInterval(sample);
      files.closeAll();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  300000,
);

import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Files, LocalAdapter } from "../src/main/files";
import type { Store } from "../src/main/store";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

it.each(["EPERM", "EACCES", "EINVAL", "ENOENT"])(
  "lists accessible siblings when an entry cannot be inspected (%s)",
  async (code) => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "passport-files-"),
    );
    directories.push(directory);
    const visible = path.join(directory, "visible.txt");
    await fs.writeFile(visible, "visible");
    const stat = await fs.lstat(visible);
    vi.spyOn(fs, "readdir").mockResolvedValueOnce([
      "DumpStack.log.tmp",
      "visible.txt",
    ] as never);
    vi.spyOn(fs, "lstat")
      .mockRejectedValueOnce(
        Object.assign(new Error("protected entry"), { code }),
      )
      .mockResolvedValueOnce(stat);
    const adapter = new LocalAdapter();
    const files = new Files(
      { read: () => ({ hosts: [] }) } as unknown as Store,
      async () => true,
    );
    files.adapters.set(adapter.endpoint.id, adapter);
    const { entries } = await files.list(adapter.endpoint.id, directory);
    expect(entries).toEqual([
      expect.objectContaining({
        name: "visible.txt",
        path: visible,
        kind: "file",
        size: 7,
      }),
    ]);
  },
);

it("reports an inaccessible directory instead of showing an empty listing", async () => {
  const error = Object.assign(new Error("protected directory"), {
    code: "EACCES",
  });
  vi.spyOn(fs, "readdir").mockRejectedValueOnce(error);
  await expect(new LocalAdapter().list("protected")).rejects.toBe(error);
});

it("reports unexpected entry failures and keeps explicit file access errors", async () => {
  const adapter = new LocalAdapter();
  vi.spyOn(fs, "readdir").mockResolvedValueOnce(["broken"] as never);
  const ioError = Object.assign(new Error("I/O error"), { code: "EIO" });
  const permissionError = Object.assign(new Error("protected file"), {
    code: "EPERM",
  });
  vi.spyOn(fs, "lstat")
    .mockRejectedValueOnce(ioError)
    .mockRejectedValueOnce(permissionError);
  await expect(adapter.list("folder", { skipUnreadable: true })).rejects.toBe(
    ioError,
  );
  await expect(adapter.stat("protected-file")).rejects.toBe(permissionError);
});

it.each(["EPERM", "EACCES", "EINVAL"])(
  "keeps transfer enumeration strict when a child is protected (%s)",
  async (code) => {
    const error = Object.assign(new Error("protected entry"), { code });
    vi.spyOn(fs, "readdir").mockResolvedValueOnce(["protected"] as never);
    vi.spyOn(fs, "lstat").mockRejectedValueOnce(error);
    await expect(new LocalAdapter().list("folder")).rejects.toBe(error);
  },
);

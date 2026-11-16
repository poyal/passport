import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtemp, readdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { it, expect } from "vitest";
import { UpdateDownload } from "../src/main/update-download";

it("never marks an interrupted, oversized or tampered download ready and permits retry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "passport-download-"));
  const keys = generateKeyPairSync("ed25519");
  const bytes = Buffer.from("valid package bytes");
  const manifest = Buffer.from(
    JSON.stringify({
      format: "passport-update-v1",
      version: "1.3.11",
      platforms: {
        "win32-x64": {
          name: "Passport-1.3.11-win32-x64-update.zip",
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      },
    }),
  );
  let mode = "tamper";
  const progress: number[] = [];
  const download = new UpdateDownload({
    directory: root,
    current: "1.3.10",
    target: "win32-x64",
    publicKey: keys.publicKey
      .export({ format: "pem", type: "spki" })
      .toString(),
    progress: (received) => progress.push(received),
    fetch: async (url, init) => {
      if (String(url).endsWith(".json")) return new Response(manifest);
      if (String(url).endsWith(".sig"))
        return new Response(sign(null, manifest, keys.privateKey));
      if (mode === "abort") {
        download.cancel();
        init?.signal?.throwIfAborted();
      }
      return new Response(
        mode === "oversize"
          ? Buffer.concat([bytes, bytes])
          : mode === "tamper"
            ? Buffer.alloc(bytes.length)
            : bytes,
      );
    },
  });
  try {
    for (mode of ["tamper", "oversize", "abort"]) {
      await expect(download.download("1.3.11")).rejects.toThrow();
      expect(download.ready).toBeUndefined();
      expect(await readdir(root)).toEqual([]);
    }
    mode = "valid";
    const ready = await download.download("1.3.11");
    expect(download.ready).toEqual(ready);
    expect(await readFile(path.join(ready.directory, "package.zip"))).toEqual(
      bytes,
    );
    expect(progress.at(-1)).toBe(bytes.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

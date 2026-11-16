import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  verifyUpdateManifest,
  verifyUpdatePackage,
  updateAssetURL,
} from "../src/main/update-protocol";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const item = {
  name: "Passport-1.3.11-win32-x64-update.zip",
  size: 3,
  sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
};
const fixture = (patch = {}) =>
  Buffer.from(
    JSON.stringify({
      format: "passport-update-v1",
      version: "1.3.11",
      platforms: { "win32-x64": item },
      ...patch,
    }),
  );
const check = (bytes: Buffer, signature = sign(null, bytes, keys.privateKey)) =>
  verifyUpdateManifest(bytes, signature, publicKey, "1.3.10", "1.3.11");

describe("authenticated update protocol", () => {
  it("authenticates exact bytes and constructs only the canonical repository URL", () => {
    const manifest = check(fixture());
    expect(updateAssetURL(manifest, "win32-x64")).toBe(
      "https://github.com/poyal/passport/releases/download/v1.3.11/Passport-1.3.11-win32-x64-update.zip",
    );
    expect(() => updateAssetURL(manifest, "darwin-arm64")).toThrow();
    expect(() =>
      check(
        Buffer.concat([fixture(), Buffer.from(" ")]),
        sign(null, fixture(), keys.privateKey),
      ),
    ).toThrow();
    expect(() =>
      check(
        fixture(),
        sign(null, fixture(), generateKeyPairSync("ed25519").privateKey),
      ),
    ).toThrow();
  });
  it("rejects downgrade, wrong release, malformed targets and unsafe filenames even if signed", () => {
    for (const patch of [
      { version: "1.3.9" },
      { version: "1.3.12" },
      { version: "1.3.11-dev" },
      { platforms: { linux: item } },
      { platforms: { "win32-x64": { ...item, name: "../app.zip" } } },
      { platforms: { "win32-x64": { ...item, size: -1 } } },
      {
        platforms: {
          "win32-x64": { ...item, url: "https://evil.test/app.zip" },
        },
      },
    ])
      expect(() => check(fixture(patch))).toThrow();
    expect(() => check(Buffer.alloc(65537))).toThrow();
    expect(() => check(fixture(), Buffer.alloc(63))).toThrow();
  });
  it("streams package verification and rejects truncated or changed bytes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "passport-update-test-"));
    try {
      const file = path.join(root, "package.zip");
      await writeFile(file, "abc");
      await expect(verifyUpdatePackage(file, item)).resolves.toBeUndefined();
      await writeFile(file, "abd");
      await expect(verifyUpdatePackage(file, item)).rejects.toThrow();
      await writeFile(file, "ab");
      await expect(verifyUpdatePackage(file, item)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

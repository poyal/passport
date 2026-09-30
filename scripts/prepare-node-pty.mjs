import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function prepareWindowsPty(sourceRoot, targetRoot, arch) {
  assert.ok(
    ["x64", "arm64"].includes(arch),
    "Unsupported Windows PTY architecture",
  );
  const versions = await fs.readdir(
    path.join(sourceRoot, "third_party/conpty"),
  );
  assert.equal(versions.length, 1, "Expected one bundled ConPTY version");
  const source = path.join(
    sourceRoot,
    "third_party/conpty",
    versions[0],
    `win10-${arch}`,
  );
  let prepared = 0;
  for (const relative of [
    "build/Release",
    "build/Debug",
    `prebuilds/win32-${arch}`,
  ]) {
    const nativeRoot = path.join(targetRoot, relative);
    try {
      await fs.access(path.join(nativeRoot, "conpty.node"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    // electron-builder's native rebuild removes node-pty's postinstall copy.
    // ConPTY resolves these files beside the native module it actually loads.
    const destination = path.join(nativeRoot, "conpty");
    await fs.mkdir(destination, { recursive: true });
    for (const file of ["conpty.dll", "OpenConsole.exe"])
      await fs.copyFile(path.join(source, file), path.join(destination, file));
    prepared++;
  }
  assert.ok(prepared, "No Windows ConPTY native module was found");
  console.log(
    `Prepared bundled ConPTY for ${arch} in ${prepared} native module directories`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.platform === "win32") {
    const root = path.resolve("node_modules/node-pty");
    await prepareWindowsPty(
      root,
      root,
      process.env.npm_config_arch || process.arch,
    );
  }
}

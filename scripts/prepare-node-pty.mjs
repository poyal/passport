import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function patchWindowsPtyAgent(root) {
  const { version } = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  );
  assert.equal(
    version,
    "1.1.0",
    "Review the Windows PTY drain patch for the new node-pty version",
  );
  const filename = path.join(root, "lib/windowsPtyAgent.js");
  const source = await fs.readFile(filename, "utf8");
  const marker =
    "// Passport: drain and close even when no output follows kill.";
  if (source.includes(marker)) return;
  const original = `this._inSocket.destroy();
                this._ptyNative.kill(this._pty, this._useConptyDll);
                this._outSocket.on('data', function () {
                    _this._conoutSocketWorker.dispose();
                });`;
  const replacement = `${original}
                ${marker}
                this._conoutSocketWorker.dispose();`;
  const normalized = source.replaceAll("\r\n", "\n");
  assert.equal(
    normalized.split(original).length,
    2,
    "Review the node-pty Windows shutdown implementation",
  );
  await fs.writeFile(filename, normalized.replace(original, replacement));
  console.log("node-pty: Windows quiet-output shutdown patch applied");
}

export async function prepareWindowsPty(sourceRoot, targetRoot, arch) {
  assert.ok(
    ["x64", "arm64"].includes(arch),
    "Unsupported Windows PTY architecture",
  );
  await patchWindowsPtyAgent(sourceRoot);
  if (path.resolve(sourceRoot) !== path.resolve(targetRoot))
    await patchWindowsPtyAgent(targetRoot);
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

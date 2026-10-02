import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const originalConptySource =
  "52c893b689ab3210c0961e2a6aa805a82350003767b21069b164926b5becd4e2";
const fixedConptySource =
  "a000a53daa90506662e4747c6585a403b93431d1fe46f99895aa6d58faaa9082";
const conptySourceHash = async (root) =>
  createHash("sha256")
    .update(
      (
        await fs.readFile(path.join(root, "src/win/conpty.cc"), "utf8")
      ).replaceAll("\r\n", "\n"),
    )
    .digest("hex");

export async function patchWindowsConpty(root) {
  const hash = await conptySourceHash(root);
  if (hash === fixedConptySource) return;
  assert.equal(
    hash,
    originalConptySource,
    "Review the node-pty ConPTY race patch",
  );
  const project = fileURLToPath(new URL("..", import.meta.url));
  const directory = path.relative(project, root);
  assert.ok(
    directory && !directory.startsWith("..") && !path.isAbsolute(directory),
  );
  // Backport microsoft/node-pty#922 (004a99cd), preserving its MIT attribution.
  // Serialize vector access and baton lifetime across JS and exit watcher threads.
  // Windows checkouts can convert the tracked patch to CRLF while npm's C++
  // source retains LF. Apply normalized bytes; the exact source hashes below
  // still reject changed context or changed patch output.
  const sourceFile = path.join(root, "src/win/conpty.cc");
  await fs.writeFile(
    sourceFile,
    (await fs.readFile(sourceFile, "utf8")).replaceAll("\r\n", "\n"),
  );
  const patch = (
    await fs.readFile(
      fileURLToPath(
        new URL("./patches/node-pty-conpty-race.patch", import.meta.url),
      ),
      "utf8",
    )
  ).replaceAll("\r\n", "\n");
  const args = [
    "apply",
    `--directory=${directory.split(path.sep).join("/")}`,
    "-",
  ];
  execFileSync("git", [...args.slice(0, 1), "--check", ...args.slice(1)], {
    cwd: project,
    windowsHide: true,
    input: patch,
  });
  execFileSync("git", args, { cwd: project, windowsHide: true, input: patch });
  assert.equal(await conptySourceHash(root), fixedConptySource);
  console.log("node-pty: upstream Windows ConPTY race fix applied");
}

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
  assert.equal(
    await conptySourceHash(sourceRoot),
    fixedConptySource,
    "Run npm ci to build node-pty with the Windows ConPTY race fix",
  );
  const fixedNative = path.join(sourceRoot, "build/Release/conpty.node");
  await fs.access(fixedNative);
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
    // Every loader fallback for this architecture must use the compiled fix,
    // including the upstream prebuilt directory. Builder excludes C++ sources.
    const native = path.join(nativeRoot, "conpty.node");
    if (path.resolve(native) !== path.resolve(fixedNative))
      await fs.copyFile(fixedNative, native);
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
    await patchWindowsConpty(root);
    const { rebuild } = await import("@electron/rebuild");
    const electron = JSON.parse(
      await fs.readFile("node_modules/electron/package.json", "utf8"),
    );
    // Prebuilt modules and ABI-only rebuild caches cannot establish that this
    // native source fix is present. Compile the pinned source explicitly.
    await rebuild({
      buildPath: path.resolve("."),
      electronVersion: electron.version,
      arch: process.env.npm_config_arch || process.arch,
      onlyModules: ["node-pty"],
      force: true,
      buildFromSource: true,
    });
    await prepareWindowsPty(
      root,
      root,
      process.env.npm_config_arch || process.arch,
    );
  }
}

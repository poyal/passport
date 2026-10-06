import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { getPath7za } from "app-builder-lib/out/toolsets/7zip.js";

const arch =
  process.argv[2] || process.env.PASSPORT_TARGET_ARCH || process.arch;
const root = path.resolve("resources/terminal");
const manifest = JSON.parse(
  await fs.readFile(path.join(root, "runtime-manifest.json"), "utf8"),
);
const asset = manifest.assets[arch];
if (!asset) throw new Error("Windows runtime builds require x64.");
const destination = path.join(root, "runtime", arch);
try {
  const installed = JSON.parse(
    await fs.readFile(path.join(destination, "passport-runtime.json"), "utf8"),
  );
  if (
    installed.sha256 === asset.sha256 &&
    (await fs.stat(path.join(destination, "bin/bash.exe"))).isFile()
  ) {
    await fs.writeFile(
      path.join(destination, "passport-runtime.json"),
      JSON.stringify({ ...manifest, arch, sha256: asset.sha256 }, null, 2),
    );
    console.log(`Passport Bash ${arch} already prepared.`);
    process.exit(0);
  }
} catch {
  /* prepare */
}
const cache = path.resolve("build/runtime-downloads");
await fs.mkdir(cache, { recursive: true });
const archive = path.join(cache, asset.name);
let bytes;
try {
  bytes = await fs.readFile(archive);
} catch {
  /* download */
}
if (
  !bytes ||
  createHash("sha256").update(bytes).digest("hex") !== asset.sha256
) {
  console.log(
    `Downloading official Portable Git ${manifest.version} (${arch})`,
  );
  const response = await fetch(
    `https://github.com/git-for-windows/git/releases/download/v${manifest.version}/${asset.name}`,
    { signal: AbortSignal.timeout(180000) },
  );
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 100 * 1024 * 1024)
      throw new Error("Runtime archive is larger than expected");
    chunks.push(chunk);
  }
  bytes = Buffer.concat(chunks);
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
    throw new Error("Portable Git SHA-256 mismatch");
  await fs.writeFile(archive, bytes);
}
const staging = `${destination}.staging`;
await fs.rm(staging, { recursive: true, force: true });
await fs.mkdir(staging, { recursive: true });
const unzip = await getPath7za();
const extracted = spawnSync(unzip, ["x", "-y", `-o${staging}`, archive], {
  stdio: "pipe",
});
if (extracted.status !== 0)
  throw new Error(
    `Portable Git extraction failed: ${extracted.stderr?.toString()}`,
  );
const autoProfile = path.join(staging, "etc/profile.d/bash_profile.sh");
await fs.rename(autoProfile, `${autoProfile}.passport-original`);
await fs.writeFile(
  autoProfile,
  "# Passport: user startup file generation is intentionally disabled.\n# Original: bash_profile.sh.passport-original (same directory).\n",
);
for (const file of [
  "bin/bash.exe",
  "usr/bin/sh.exe",
  "usr/bin/ls.exe",
  "usr/bin/grep.exe",
  "usr/bin/sed.exe",
  "usr/bin/awk.exe",
  "usr/bin/less.exe",
  "usr/bin/find.exe",
  "usr/bin/ssh.exe",
  "cmd/git.exe",
])
  await fs.access(path.join(staging, file));
await fs.writeFile(
  path.join(staging, "passport-runtime.json"),
  JSON.stringify({ ...manifest, arch, sha256: asset.sha256 }, null, 2),
);
await fs.rm(destination, { recursive: true, force: true });
await fs.rename(staging, destination);
console.log(
  `Prepared Passport Bash ${arch}; verified checksum, executables, and home-file patch.`,
);

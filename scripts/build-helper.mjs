import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  copyFileSync,
  chmodSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
const arch = process.env.PASSPORT_TARGET_ARCH || process.arch;
const platform = process.env.PASSPORT_TARGET_PLATFORM || process.platform;
const targets = {
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};
const target = targets[`${platform}-${arch}`];
if (!target) throw new Error(`Unsupported helper target: ${platform}-${arch}`);
const cargo = process.env.PASSPORT_CARGO || "cargo";
const result = spawnSync(
  cargo,
  [
    "build",
    "--locked",
    "--release",
    "--manifest-path",
    "native/helper/Cargo.toml",
    "--target",
    target,
  ],
  { stdio: "inherit" },
);
if (result.error || result.status)
  throw new Error(
    `Rust helper build failed: ${result.error || result.status}. Install the stable Rust toolchain and target.`,
  );
const name = platform === "win32" ? "passport-helper.exe" : "passport-helper";
const directory = `resources/terminal/helper/${platform}-${arch}`;
mkdirSync(directory, { recursive: true });
copyFileSync(
  path.join("native/helper/target", target, "release", name),
  path.join(directory, name),
);
if (platform !== "win32") chmodSync(path.join(directory, name), 0o755);
const metadata = spawnSync(
  cargo,
  [
    "metadata",
    "--locked",
    "--format-version",
    "1",
    "--manifest-path",
    "native/helper/Cargo.toml",
  ],
  { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
);
if (metadata.status !== 0)
  throw new Error("Cannot collect native helper license metadata");
const licenses = path.join(directory, "licenses");
mkdirSync(licenses, { recursive: true });
const dependencies = [];
for (const dependency of JSON.parse(metadata.stdout).packages.filter(
  (p) => p.source,
)) {
  dependencies.push(
    `| ${dependency.name} | ${dependency.version} | ${dependency.license || "See license file"} |`,
  );
  const source = path.dirname(dependency.manifest_path);
  for (const file of readdirSync(source).filter((f) =>
    /^(license|copying|copyright|notice)(\.|-|$)/i.test(f),
  )) {
    try {
      copyFileSync(
        path.join(source, file),
        path.join(licenses, `${dependency.name}-${dependency.version}-${file}`),
      );
    } catch {
      /* directories are not license texts */
    }
  }
}
writeFileSync(
  path.join(licenses, "DEPENDENCIES.md"),
  `# Passport native helper dependencies\n\n| Package | Version | License |\n| --- | --- | --- |\n${dependencies.join("\n")}\n`,
);

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourceState, writeJSON, hashFile } from "./release-core.mjs";
import { runCommand } from "./release-process.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const platform = `${process.platform}-${process.arch}`;
if (!["win32-x64", "darwin-arm64"].includes(platform))
  throw new Error(`Unsupported development package target: ${platform}`);
const source = await sourceState(root);
const pkg = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
);
const version = pkg.version.replace(/-dev$/, "") + "-dev";
const target = process.platform === "win32" ? "win-x64" : "mac-arm64";
const createdAt = new Date().toISOString();
const id = `${createdAt.replace(/[-:]/g, "").replace(/\.\d+Z/, "Z")}-${source.commit.slice(0, 7)}${source.dirty ? "-dirty" : ""}-${target}-dev`;
const output = path.join(root, "release/builds", id);
const checks = path.join(root, "release/checks", id);
const appRoot =
  process.platform === "win32"
    ? path.join(output, "win-unpacked")
    : path.join(output, "mac-arm64/Passport-dev.app/Contents");
const executable =
  process.platform === "win32"
    ? path.join(appRoot, "Passport-dev.exe")
    : path.join(appRoot, "MacOS/Passport-dev");
const resources = path.join(
  appRoot,
  process.platform === "win32" ? "resources" : "Resources",
);
const metadata = {
  createdAt,
  purpose: "Development app for local testing",
  source: "local",
  sourceCommit: source.commit,
  dirty: source.dirty,
  sourceFingerprint: source.fingerprint,
  changedFiles: source.changes || [],
  platform: target,
  version,
  productName: "Passport-dev",
  appId: "io.passport.desktop.dev",
  status: "running",
  publishable: false,
  executable: path.relative(root, executable),
  checks: path.relative(root, checks),
};
async function record() {
  await writeJSON(path.join(output, "artifact.json"), metadata);
  await writeJSON(path.join(checks, "artifact.json"), metadata);
}
await record();
try {
  const env = { ...process.env, PASSPORT_BUILD_CHANNEL: "dev" };
  const run = (args, log) =>
    runCommand(process.execPath, args, {
      cwd: root,
      env,
      log: path.join(checks, log),
      timeout: 10 * 60 * 1000,
    });
  await run(["node_modules/typescript/bin/tsc", "--noEmit"], "types.log");
  await run(["scripts/build.mjs"], "build.log");
  await run(
    [
      "node_modules/electron-builder/cli.js",
      process.platform === "win32" ? "--win" : "--mac",
      process.platform === "win32" ? "--x64" : "--arm64",
      "--dir",
      "--publish",
      "never",
      `--config.directories.output=${output}`,
      "--config.productName=Passport-dev",
      "--config.appId=io.passport.desktop.dev",
      "--config.extraMetadata.name=passport-dev",
      `--config.extraMetadata.version=${version}`,
    ],
    "package.log",
  );
  metadata.files = await Promise.all(
    [
      executable,
      path.join(resources, "app.asar"),
      path.join(
        resources,
        "terminal/helper",
        platform,
        process.platform === "win32" ? "passport.exe" : "passport",
      ),
    ].map(async (file) => ({
      path: path.relative(root, file),
      bytes: (await fs.stat(file)).size,
      sha256: await hashFile(file),
    })),
  );
  metadata.status = "built-unverified";
  console.log(`Development app: ${executable}\nBuild record: ${checks}`);
} catch (error) {
  metadata.status = "failed";
  metadata.error = error.message;
  throw error;
} finally {
  await record();
}

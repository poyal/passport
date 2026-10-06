import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sourceState, writeJSON } from "./release-core.mjs";
import { runCommand } from "./release-process.mjs";
import { summarizeElectronLifecycle } from "./e2e-lifecycle.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const modes = args.filter((arg) => ["--show", "--desktop"].includes(arg));
if (modes.length > 1) throw new Error("Choose --show or --desktop, not both");
const mode =
  modes[0] === "--desktop"
    ? "desktop"
    : modes[0] === "--show"
      ? "passive"
      : "hidden";
const source = await sourceState(root);
const platform = `${process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
const id = `${new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(
    /\.\d+Z/,
    "Z",
  )}-${source.commit.slice(0, 7)}${source.dirty ? "-dirty" : ""}-${platform}-e2e-${mode}`;
const directory = path.join(root, "release/checks", id);
const metadata = {
  createdAt: new Date().toISOString(),
  purpose: "E2E without interrupting the desktop",
  source: "local",
  sourceCommit: source.commit,
  dirty: source.dirty,
  platform,
  sourceFingerprint: source.fingerprint,
  changedFiles: source.changes || [],
  mode,
  status: "running",
};
await writeJSON(path.join(directory, "artifact.json"), metadata);
console.log(
  `E2E mode: ${mode}. ${mode === "desktop" ? "Native focus and clipboard tests will use the desktop." : "Native window focus is disabled; @desktop tests are excluded."}`,
);
try {
  await runCommand(
    process.execPath,
    [
      path.join(root, "node_modules/@playwright/test/cli.js"),
      "test",
      ...args.filter((arg) => !modes.includes(arg)),
      "--max-failures=1",
      "--output",
      path.join(directory, "results"),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PASSPORT_E2E_MODE: mode,
        PASSPORT_TEST_REPORT: path.join(directory, "report.json"),
        PASSPORT_SHUTDOWN_DIAGNOSTICS: directory,
        PASSPORT_E2E_LIFECYCLE_LOG: path.join(directory, "lifecycle.jsonl"),
      },
      log: path.join(directory, "e2e.log"),
      timeout: 15 * 60 * 1000,
    },
  );
  if (args.includes("--list")) metadata.status = "listed";
  else {
    const report = JSON.parse(
      await fs.readFile(path.join(directory, "report.json"), "utf8"),
    );
    metadata.tests = report.stats;
    metadata.status = report.stats.expected > 0 ? "passed" : "skipped";
  }
} catch (error) {
  metadata.status = "failed";
  metadata.error = error.message;
  process.exitCode = 1;
} finally {
  try {
    const events = (
      await fs.readFile(path.join(directory, "lifecycle.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    metadata.lifecycle = summarizeElectronLifecycle(events);
    console.log(`Electron lifecycle: ${JSON.stringify(metadata.lifecycle)}`);
  } catch (error) {
    if (error.code !== "ENOENT") {
      metadata.status = "failed";
      metadata.error = `Lifecycle evidence: ${error.message}`;
      process.exitCode = 1;
    }
  }
  metadata.finishedAt = new Date().toISOString();
  await writeJSON(path.join(directory, "artifact.json"), metadata);
  console.log(`E2E evidence: ${path.relative(root, directory)}`);
}

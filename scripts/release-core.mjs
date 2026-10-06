import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import {
  guiCheckModes,
  loadGuiPolicy,
  validateGuiReport,
} from "./release-gui-policy.mjs";

export const repository = "poyal/passport";
// Approved for the previously unpublished Windows 1.1.1 installer only.
// The existing Mac release tag and installer remain immutable inputs.
export const initialWindowsRelease = Object.freeze({
  version: "1.1.1",
  target: "win-x64",
  releaseCommit: "f4497cc2a337c5f5aa73d5834a2b99f06013020d",
  sourceTag: "v1.1.1-win-x64",
  macAsset: {
    id: 605237202,
    name: "Passport-1.1.1-mac-arm64.dmg",
    size: 169143903,
    digest:
      "sha256:0820760270d00b9e02deded76ec73a9eb08c22c61cb8601d7eb470d00e9df187",
  },
});
// User explicitly requested replacing the published Windows icon bugfix in
// 1.1.1. Pin the superseded installer and use a new source tag; keep Mac intact.
export const windowsIconReplacement = Object.freeze({
  sourceTag: "v1.1.1-win-x64-icon-fix",
  previousCommit: "62457a0f85d858354472212bdf4595e397b7eb91",
  asset: {
    id: 605898019,
    name: "Passport-1.1.1-win-x64.exe",
    size: 203717724,
    digest:
      "sha256:9a3c69c68da8283378561a5074524fd926a7cfca1627d69082d7cb25a37d1fcf",
  },
});
export function usesInitialWindowsSource(receipt) {
  return (
    receipt.version === initialWindowsRelease.version &&
    receipt.target === initialWindowsRelease.target &&
    receipt.source.commit !== initialWindowsRelease.releaseCommit
  );
}
export const schemaVersion = 3;
export const targets = {
  "mac-arm64": { platform: "darwin", arch: "arm64", extension: "dmg" },
  "win-x64": { platform: "win32", arch: "x64", extension: "exe" },
};
export const requiredChecks = [
  "dependencies",
  "ftp-fixtures",
  "build",
  "unit",
  "release-tests",
  "source-gui",
  "source-desktop",
  "package",
  "installer",
  "packaged-smoke",
  "packaged-gui",
  "packaged-desktop",
];
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export async function hashFile(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}
export async function writeJSON(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, filename);
}
export function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}
export async function sourceState(root) {
  const commit = git(root, "rev-parse", "HEAD");
  const dirty = Boolean(
    git(root, "status", "--porcelain", "--untracked-files=all"),
  );
  // A clean Git tree has the same identity on Windows and macOS, including
  // checkouts with different line-ending and executable-bit handling.
  if (!dirty)
    return {
      commit,
      dirty,
      fingerprint: sha256(git(root, "rev-parse", "HEAD^{tree}")),
    };
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  );
  const hash = createHash("sha256");
  for (const name of [...new Set(files.split("\0").filter(Boolean))].sort()) {
    const filename = path.join(root, name);
    hash.update(`${name}\0`);
    try {
      const stat = await fs.lstat(filename);
      hash.update(`${stat.mode & 0o777}\0`);
      hash.update(
        stat.isSymbolicLink()
          ? `link:${await fs.readlink(filename)}`
          : await hashFile(filename),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hash.update("deleted");
    }
    hash.update("\0");
  }
  const changes = execFileSync(
    "git",
    ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .map((entry) => ({ status: entry.slice(0, 2), path: entry.slice(3) }));
  return { commit, dirty, fingerprint: hash.digest("hex"), changes };
}
export function assertSameSource(before, after) {
  assert.equal(
    after.commit,
    before.commit,
    "Source commit changed; verify again.",
  );
  assert.equal(
    after.fingerprint,
    before.fingerprint,
    "Source files changed; verify again.",
  );
  assert.equal(
    after.dirty,
    before.dirty,
    "Working tree state changed; verify again.",
  );
}
export function installerName(version, target) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.ok(targets[target], "Unsupported release target");
  return `Passport-${version}-${target}.${targets[target].extension}`;
}
export async function releasePath(root, relative) {
  assert.equal(typeof relative, "string", "Missing artifact path");
  const filename = path.resolve(root, relative);
  const releaseRoot = path.resolve(root, "release");
  const inside = path.relative(releaseRoot, filename);
  assert.ok(
    inside &&
      !inside.startsWith(`..${path.sep}`) &&
      inside !== ".." &&
      !path.isAbsolute(inside),
    "Artifacts must be inside release/",
  );
  const real = await fs.realpath(filename);
  const realRoot = await fs.realpath(releaseRoot);
  const realRelative = path.relative(realRoot, real);
  assert.ok(
    realRelative &&
      !realRelative.startsWith(`..${path.sep}`) &&
      realRelative !== ".." &&
      !path.isAbsolute(realRelative),
    "Artifact symlink escapes release/",
  );
  return filename;
}
export async function validateReceipt(root, receipt, state) {
  state ??= await sourceState(root);
  assert.equal(
    receipt.schemaVersion,
    schemaVersion,
    "Unknown verification receipt format",
  );
  assert.equal(receipt.repository, repository, "Wrong release repository");
  assert.equal(
    receipt.status,
    "verified",
    "Only a completed release verification can be published",
  );
  assert.equal(
    receipt.preview,
    false,
    "Preview builds cannot be published; commit and verify again.",
  );
  assert.equal(receipt.source.dirty, false, "Dirty builds cannot be published");
  assert.equal(state.dirty, false, "Commit local changes before publishing");
  assertSameSource(receipt.source, state);
  if (usesInitialWindowsSource(receipt)) {
    execFileSync(
      "git",
      [
        "merge-base",
        "--is-ancestor",
        initialWindowsRelease.releaseCommit,
        state.commit,
      ],
      { cwd: root, stdio: "pipe" },
    );
    const allowed = new Set([
      ".gitignore",
      "README.md",
      "package.json",
      "scripts/build.mjs",
      "scripts/windows-icon-smoke.ps1",
      "src/main/index.ts",
      "src/main/local.ts",
      "src/main/startup.ts",
      "scripts/e2e-electron.mjs",
      "scripts/prepare-node-pty.mjs",
      "scripts/patches/node-pty-conpty-race.patch",
      "scripts/release-core.mjs",
      "scripts/release-publish.mjs",
      "scripts/release-verify.mjs",
      "tests/e2e/local-workspace.spec.ts",
      "tests/e2e/background.spec.ts",
      "tests/e2e/paste.spec.ts",
      "tests/e2e/windows-shells.spec.ts",
      "tests/runtime.test.ts",
      "tests/release.test.mjs",
      "vitest.config.ts",
    ]);
    const changed = git(
      root,
      "diff",
      "--name-only",
      initialWindowsRelease.releaseCommit,
      state.commit,
    )
      .split(/\r?\n/)
      .filter(Boolean);
    assert.ok(
      changed.every(
        (file) => allowed.has(file) || /^docs\/.*\.(md|json)$/.test(file),
      ),
      "Windows 1.1.1 source includes changes outside the approved bugfix, tests, verification and documentation scope",
    );
  }
  const pkg = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  );
  assert.equal(receipt.version, pkg.version, "Package version changed");
  assert.equal(
    receipt.artifact.name,
    installerName(pkg.version, receipt.target),
  );
  for (const name of requiredChecks) {
    const matches = receipt.checks.filter((check) => check.name === name);
    assert.equal(matches.length, 1, `Missing or duplicate check: ${name}`);
    assert.equal(matches[0].status, "passed", `Check did not pass: ${name}`);
  }
  assert.ok(
    receipt.checks.every((check) => check.status === "passed"),
    "Verification contains failed checks",
  );
  assert.equal(receipt.environment.platform, targets[receipt.target].platform);
  assert.equal(receipt.environment.arch, targets[receipt.target].arch);
  const filename = await releasePath(root, receipt.artifact.path);
  assert.equal(path.basename(filename), receipt.artifact.name);
  assert.equal(
    (await fs.stat(filename)).size,
    receipt.artifact.bytes,
    "Installer size changed",
  );
  assert.equal(
    await hashFile(filename),
    receipt.artifact.sha256,
    "Installer hash changed; verify again.",
  );
  for (const evidence of receipt.evidence) {
    const file = await releasePath(root, evidence.path);
    assert.equal(
      await hashFile(file),
      evidence.sha256,
      `Verification evidence changed: ${evidence.path}`,
    );
  }
  assert.ok(
    receipt.evidence.length >= requiredChecks.length,
    "Missing verification evidence",
  );
  const policy = loadGuiPolicy(root);
  assert.ok(
    Array.isArray(receipt.guiOptionalFeatures),
    "Missing optional GUI feature selection",
  );
  for (const [name, mode] of Object.entries(guiCheckModes)) {
    const check = receipt.checks.find((check) => check.name === name);
    assert.equal(check.mode, mode, `Wrong GUI mode for ${name}`);
    const reportPath = await releasePath(root, check.report);
    assert.equal(
      receipt.evidence.filter((item) => item.path === check.report).length,
      1,
      `Missing or duplicate GUI report evidence for ${name}`,
    );
    const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
    const coverage = validateGuiReport(
      report,
      {
        platform: receipt.environment.platform,
        mode,
        optional: receipt.guiOptionalFeatures,
      },
      policy,
    );
    assert.deepEqual(
      check.tests,
      report.stats,
      `GUI summary was changed: ${name}`,
    );
    assert.deepEqual(
      check.coverage,
      coverage,
      `GUI coverage was changed: ${name}`,
    );
  }
  return filename;
}
export async function withReleaseLock(root, action) {
  const filename = path.join(root, "release/checks/local-release.lock");
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const handle = await fs.open(filename, "wx").catch((error) => {
    if (error.code === "EEXIST")
      throw new Error(
        "Another local release owns release/checks/local-release.lock. If it crashed, inspect its PID before removing the lock.",
      );
    throw error;
  });
  try {
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        workingDirectory: path.resolve(root),
        scope: "working-directory",
        createdAt: new Date().toISOString(),
      }),
    );
    return await action();
  } finally {
    await handle.close();
    await fs.unlink(filename);
  }
}
export function parseArguments(args) {
  const options = {
    manifests: [],
    preview: false,
    desktop: false,
    execute: false,
    help: false,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (
      [
        "--preview",
        "--desktop",
        "--execute",
        "--help",
        "--replace-windows-icon",
      ].includes(arg)
    )
      options[arg.slice(2)] = true;
    else if (arg === "--manifest") {
      const value = args[++index];
      assert.ok(
        value && !value.startsWith("--"),
        "--manifest needs a verification.json path",
      );
      options.manifests.push(value);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

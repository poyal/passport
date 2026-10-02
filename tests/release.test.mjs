import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  repository,
  schemaVersion,
  requiredChecks,
  sourceState,
  sha256,
  hashFile,
  installerName,
  validateReceipt,
  parseArguments,
  withReleaseLock,
} from "../scripts/release-core.mjs";
import {
  publicationPlan,
  publishVerified,
  tagCommit,
  githubClient,
} from "../scripts/release-publish.mjs";
import { runCommand } from "../scripts/release-process.mjs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { closeCleanly } from "./fixtures/electron-exit.ts";
import { e2eMode } from "../scripts/e2e-mode.mjs";
import {
  guiCheckModes,
  loadGuiPolicy,
  requestedGuiFeatures,
  validateGuiReport,
} from "../scripts/release-gui-policy.mjs";

// Synthetic reporter output for gate and publication tests; no Electron launch.
function guiReport(platform = "darwin", mode = "hidden", optional = []) {
  const entries = loadGuiPolicy().policy.tests.filter(
    (entry) => (entry.mode || "hidden") === mode,
  );
  const specs = entries.map((entry) => {
    const skipped =
      !(entry.platforms || ["darwin", "win32"]).includes(platform) ||
      (entry.optional && !optional.includes(entry.optional));
    return {
      file: entry.file,
      title: entry.title,
      tests: [
        {
          expectedStatus: skipped ? "skipped" : "passed",
          status: skipped ? "skipped" : "expected",
          results: [
            { status: skipped ? "skipped" : "passed", retry: 0, errors: [] },
          ],
        },
      ],
    };
  });
  const skipped = specs.filter(
    (spec) => spec.tests[0].status === "skipped",
  ).length;
  return {
    errors: [],
    suites: [{ specs }],
    stats: {
      expected: specs.length - skipped,
      skipped,
      unexpected: 0,
      flaky: 0,
    },
  };
}

function skipSpec(report, spec) {
  spec.tests[0].expectedStatus = "skipped";
  spec.tests[0].status = "skipped";
  spec.tests[0].results[0].status = "skipped";
  report.stats.expected--;
  report.stats.skipped++;
}

async function fixture(t, target = "mac-arm64") {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-release-test-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "docs/releases"), { recursive: true });
  await fs.mkdir(path.join(root, "tests/e2e"), { recursive: true });
  await fs.writeFile(
    path.join(root, "tests/e2e/release-policy.json"),
    JSON.stringify(loadGuiPolicy().policy),
  );
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ version: "2.0.0" }),
  );
  await fs.writeFile(path.join(root, ".gitignore"), "release/\n");
  await fs.writeFile(
    path.join(root, "docs/releases/v2.0.0.md"),
    "Release notes\n",
  );
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init");
  git("add", ".");
  git(
    "-c",
    "user.name=Release Test",
    "-c",
    "user.email=release-test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Fixture",
  );
  const artifactPath = `release/builds/test/${installerName("2.0.0", target)}`;
  await fs.mkdir(path.dirname(path.join(root, artifactPath)), {
    recursive: true,
  });
  const bytes = Buffer.from(`verified installer ${target}`);
  await fs.writeFile(path.join(root, artifactPath), bytes);
  const evidence = [];
  for (const name of requiredChecks) {
    const filename = `release/checks/test/${name}.log`;
    await fs.mkdir(path.dirname(path.join(root, filename)), {
      recursive: true,
    });
    await fs.writeFile(path.join(root, filename), `${name} passed\n`);
    evidence.push({
      path: filename,
      sha256: await hashFile(path.join(root, filename)),
    });
  }
  const platform = target.startsWith("mac") ? "darwin" : "win32";
  const checks = requiredChecks.map((name) => ({ name, status: "passed" }));
  for (const [name, mode] of Object.entries(guiCheckModes)) {
    const report = guiReport(platform, mode);
    const filename = `release/checks/test/${name}.json`;
    await fs.writeFile(path.join(root, filename), JSON.stringify(report));
    evidence.push({
      path: filename,
      sha256: await hashFile(path.join(root, filename)),
    });
    Object.assign(
      checks.find((check) => check.name === name),
      {
        mode,
        report: filename,
        tests: report.stats,
        coverage: validateGuiReport(report, { platform, mode }),
      },
    );
  }
  const receipt = {
    schemaVersion,
    repository,
    version: "2.0.0",
    target,
    source: await sourceState(root),
    status: "verified",
    preview: false,
    guiOptionalFeatures: [],
    environment: {
      platform,
      arch: target.endsWith("arm64") ? "arm64" : "x64",
    },
    checks,
    evidence,
    artifact: {
      name: path.basename(artifactPath),
      path: artifactPath,
      bytes: bytes.length,
      sha256: sha256(bytes),
    },
  };
  return { root, receipt, bytes, git };
}

function fakeGitHub(commit) {
  let sequence = 10;
  const blobs = new Map();
  const state = {
    release: null,
    assets: [],
    mutations: [],
    failChecksums: false,
    corruptDownload: false,
  };
  const copy = (value) => structuredClone(value);
  const add = (name, bytes) => {
    const asset = {
      id: sequence++,
      name,
      size: bytes.length,
      state: "uploaded",
      digest: `sha256:${sha256(bytes)}`,
      updated_at: "2026-10-02T00:00:00Z",
      download_count: 0,
    };
    blobs.set(asset.id, bytes);
    state.assets.push(asset);
    return copy(asset);
  };
  const client = {
    getTag: async () => ({ object: { type: "commit", sha: commit } }),
    getRelease: async () => copy(state.release),
    getAssets: async () => copy(state.assets),
    download: async (asset) => {
      state.assets.find((item) => item.id === asset.id).download_count++;
      return state.corruptDownload
        ? Buffer.from("corrupt")
        : blobs.get(asset.id);
    },
    create: async (data) => {
      state.mutations.push(["create", data]);
      state.release = {
        ...data,
        id: 1,
        upload_url:
          "https://uploads.github.com/repos/poyal/passport/releases/1/assets{?name,label}",
        html_url: "https://github.com/poyal/passport/releases/tag/v2.0.0",
        immutable: false,
      };
      return copy(state.release);
    },
    upload: async (_, name, bytes) => {
      state.mutations.push(["upload", name]);
      if (name === "SHA256SUMS.txt" && state.failChecksums)
        throw new Error("simulated upload interruption");
      assert.ok(!state.assets.some((asset) => asset.name === name));
      return add(name, bytes);
    },
    remove: async (id) => {
      state.mutations.push(["remove", id]);
      state.assets = state.assets.filter((asset) => asset.id !== id);
    },
    update: async (_, data) => {
      state.mutations.push(["update", data]);
      Object.assign(state.release, data);
      return copy(state.release);
    },
  };
  return { state, client, add, blobs };
}

test("a clean verified installer and its evidence are accepted", async (t) => {
  const { root, receipt } = await fixture(t);
  assert.equal(
    await validateReceipt(root, receipt),
    path.join(root, receipt.artifact.path),
  );
});

test("GUI policy records platform exclusions and optional skips explicitly", () => {
  const coverage = validateGuiReport(guiReport(), {
    platform: "darwin",
    mode: "hidden",
  });
  assert.equal(coverage.passed, 53);
  assert.equal(coverage.skipped, 9);
  assert.equal(
    coverage.tests.filter(
      (test) => test.skipReason === "not applicable on darwin",
    ).length,
    6,
  );
  assert.equal(
    coverage.tests.filter((test) =>
      test.skipReason?.startsWith("optional feature"),
    ).length,
    3,
  );
  const windows = validateGuiReport(guiReport("win32"), {
    platform: "win32",
    mode: "hidden",
  });
  assert.equal(windows.skipped, 4);
  assert.equal(
    windows.tests.filter(
      (test) => test.skipReason === "not applicable on win32",
    ).length,
    1,
  );
  assert.ok(
    windows.tests
      .filter((test) => test.file.startsWith("windows-"))
      .every((test) => test.required && test.status === "passed"),
  );
});

test("GUI optional feature selection uses the actual E2E environment flags", () => {
  assert.deepEqual(requestedGuiFeatures({}), []);
  assert.deepEqual(
    requestedGuiFeatures({
      PASSPORT_DOCKER_MANIFEST: "fixture.json",
      PASSPORT_UI_STRESS: "1",
      PASSPORT_TEXT_BENCH: "1",
    }),
    ["docker", "stress", "throughput"],
  );
  assert.deepEqual(
    requestedGuiFeatures({
      PASSPORT_UI_STRESS: "0",
      PASSPORT_TEXT_BENCH: "false",
    }),
    [],
  );
});

for (const [label, mutate, error] of [
  [
    "required skip with an otherwise successful summary",
    (report) => skipSpec(report, report.suites[0].specs[0]),
    /Required GUI test was skipped/,
  ],
  [
    "missing test",
    (report) => report.suites[0].specs.pop(),
    /inventory differs/,
  ],
  [
    "renamed test",
    (report) => {
      report.suites[0].specs[0].title += " renamed";
    },
    /inventory differs/,
  ],
  [
    "duplicate test",
    (report) =>
      report.suites[0].specs.push(structuredClone(report.suites[0].specs[0])),
    /Duplicate GUI test/,
  ],
  [
    "missing result",
    (report) => {
      report.suites[0].specs[0].tests[0].results = [];
    },
    /Missing result/,
  ],
  [
    "retry",
    (report) => {
      report.suites[0].specs[0].tests[0].results[0].retry = 1;
    },
    /Retried GUI test/,
  ],
  [
    "expected failure",
    (report) => {
      report.suites[0].specs[0].tests[0].expectedStatus = "failed";
    },
    /expected failure/,
  ],
  [
    "interrupted test",
    (report) => {
      report.suites[0].specs[0].tests[0].results[0].status = "interrupted";
    },
    /did not pass/,
  ],
  [
    "incorrect summary",
    (report) => {
      report.stats.expected++;
    },
    /count disagrees/,
  ],
  [
    "global reporter error",
    (report) => {
      report.errors = [{ message: "worker died" }];
    },
    /global errors/,
  ],
]) {
  test(`GUI policy rejects ${label}`, () => {
    const report = guiReport();
    mutate(report);
    assert.throws(
      () => validateGuiReport(report, { platform: "darwin", mode: "hidden" }),
      error,
    );
  });
}

test("a missing Windows shell cannot be excused as an optional skip", () => {
  const report = guiReport("win32");
  skipSpec(
    report,
    report.suites[0].specs.find(
      (spec) => spec.file === "windows-shells.spec.ts",
    ),
  );
  assert.throws(
    () => validateGuiReport(report, { platform: "win32", mode: "hidden" }),
    /Required GUI test was skipped/,
  );
});

for (const feature of ["docker", "stress", "throughput"]) {
  test(`explicitly requested ${feature} must execute successfully`, () => {
    assert.throws(
      () =>
        validateGuiReport(guiReport(), {
          platform: "darwin",
          mode: "hidden",
          optional: [feature],
        }),
      /Required GUI test was skipped/,
    );
    const coverage = validateGuiReport(
      guiReport("darwin", "hidden", [feature]),
      { platform: "darwin", mode: "hidden", optional: [feature] },
    );
    assert.equal(coverage.skipped, 8);
  });
}

test("discovery detects a filtered native desktop test before any app launch", () => {
  const report = guiReport("darwin", "desktop");
  assert.equal(
    validateGuiReport(
      report,
      { platform: "darwin", mode: "desktop" },
      undefined,
      true,
    ).discovered,
    4,
  );
  report.suites[0].specs.pop();
  assert.throws(
    () =>
      validateGuiReport(
        report,
        { platform: "darwin", mode: "desktop" },
        undefined,
        true,
      ),
    /inventory differs/,
  );
});

for (const name of Object.keys(guiCheckModes)) {
  test(`publication rereads ${name} results even when receipt and hash claim success`, async (t) => {
    const { root, receipt } = await fixture(t);
    const check = receipt.checks.find((check) => check.name === name);
    const file = path.join(root, check.report);
    const report = JSON.parse(await fs.readFile(file, "utf8"));
    skipSpec(report, report.suites[0].specs[0]);
    await fs.writeFile(file, JSON.stringify(report));
    receipt.evidence.find((item) => item.path === check.report).sha256 =
      await hashFile(file);
    check.tests = report.stats;
    await assert.rejects(
      validateReceipt(root, receipt),
      /Required GUI test was skipped/,
    );
  });
}

test("publication rejects a fabricated coverage summary", async (t) => {
  const { root, receipt } = await fixture(t);
  receipt.checks
    .find((check) => check.name === "source-gui")
    .coverage.tests.pop();
  await assert.rejects(
    validateReceipt(root, receipt),
    /GUI coverage was changed/,
  );
});

test("publication requires the GUI feature selection and raw report evidence", async (t) => {
  const { root, receipt } = await fixture(t);
  const withoutSelection = structuredClone(receipt);
  delete withoutSelection.guiOptionalFeatures;
  await assert.rejects(
    validateReceipt(root, withoutSelection),
    /Missing optional GUI feature selection/,
  );
  const check = receipt.checks.find((check) => check.name === "source-gui");
  receipt.evidence = receipt.evidence.filter(
    (item) => item.path !== check.report,
  );
  await assert.rejects(validateReceipt(root, receipt), /GUI report evidence/);
});

test("release locks describe ownership and apply to only one working directory", async (t) => {
  const { root } = await fixture(t);
  const other = path.join(root, "release/other-checkout");
  await withReleaseLock(root, async () => {
    const owner = JSON.parse(
      await fs.readFile(
        path.join(root, "release/checks/local-release.lock"),
        "utf8",
      ),
    );
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.hostname, os.hostname());
    assert.equal(owner.workingDirectory, root);
    assert.equal(owner.scope, "working-directory");
    await assert.rejects(
      withReleaseLock(root, () => {}),
      /Another local release/,
    );
    await withReleaseLock(other, async () => {});
  });
});

for (const [label, mutate] of [
  [
    "failed verification",
    (r) => {
      r.status = "failed";
    },
  ],
  [
    "preview",
    (r) => {
      r.preview = true;
    },
  ],
  [
    "dirty build",
    (r) => {
      r.source.dirty = true;
    },
  ],
  [
    "another commit",
    (r) => {
      r.source.commit = "0".repeat(40);
    },
  ],
  [
    "different version",
    (r) => {
      r.version = "2.0.1";
    },
  ],
  [
    "missing required check",
    (r) => {
      r.checks.pop();
    },
  ],
  [
    "failed check",
    (r) => {
      r.checks[0].status = "failed";
    },
  ],
  [
    "missing desktop checks",
    (r) => {
      r.checks = r.checks.filter((check) => !check.name.endsWith("-desktop"));
    },
  ],
  [
    "wrong OS",
    (r) => {
      r.environment.platform = "win32";
    },
  ],
  [
    "missing evidence",
    (r) => {
      r.evidence = [];
    },
  ],
  [
    "outside artifact path",
    (r) => {
      r.artifact.path = "package.json";
    },
  ],
])
  test(`publishing rejects ${label} before contacting GitHub`, async (t) => {
    const { root, receipt } = await fixture(t);
    mutate(receipt);
    await assert.rejects(
      publishVerified({
        root,
        receipts: [receipt],
        client: {
          getTag: () => {
            assert.fail("must not contact GitHub");
          },
        },
        execute: true,
      }),
    );
  });

test("modified installer of the same size is rejected by hash", async (t) => {
  const { root, receipt, bytes } = await fixture(t);
  await fs.writeFile(
    path.join(root, receipt.artifact.path),
    Buffer.alloc(bytes.length, 65),
  );
  await assert.rejects(validateReceipt(root, receipt), /hash changed/);
});

test("editing source or verification evidence invalidates publication", async (t) => {
  const { root, receipt } = await fixture(t);
  await fs.appendFile(path.join(root, receipt.evidence[0].path), "changed");
  await assert.rejects(validateReceipt(root, receipt), /evidence changed/);
  await fs.writeFile(
    path.join(root, "untracked-source.js"),
    "export const changed = true;",
  );
  await assert.rejects(validateReceipt(root, receipt), /Commit local changes/);
});

test("another source commit invalidates a receipt even if package version is unchanged", async (t) => {
  const { root, receipt, git } = await fixture(t);
  await fs.writeFile(path.join(root, "new-source.js"), "// new source\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Release Test",
    "-c",
    "user.email=release-test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Changed",
  );
  await assert.rejects(validateReceipt(root, receipt), /commit changed/);
});

test(
  "artifact symlinks cannot escape release storage",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root, receipt, bytes } = await fixture(t);
    const outside = path.join(root, "outside.bin");
    await fs.writeFile(outside, bytes);
    await fs.unlink(path.join(root, receipt.artifact.path));
    await fs.symlink(outside, path.join(root, receipt.artifact.path));
    await assert.rejects(
      validateReceipt(root, receipt, receipt.source),
      /symlink escapes/,
    );
  },
);

test("dry-run plans uploads without changing the remote release", async (t) => {
  const { root, receipt } = await fixture(t);
  const { client, state } = fakeGitHub(receipt.source.commit);
  const plan = await publishVerified({ root, receipts: [receipt], client });
  assert.equal(plan.mode, "dry-run");
  assert.deepEqual(plan.upload, [receipt.artifact.name]);
  assert.deepEqual(state.mutations, []);
});

test("wrong remote tags, mixed commits, and duplicate platforms are rejected", async (t) => {
  const { receipt } = await fixture(t);
  await assert.rejects(
    publicationPlan(fakeGitHub("0".repeat(40)).client, [receipt]),
    /Remote tag differs/,
  );
  await assert.rejects(
    publicationPlan(fakeGitHub(receipt.source.commit).client, [
      receipt,
      receipt,
    ]),
    /Duplicate platform/,
  );
  const other = structuredClone(receipt);
  other.target = "win-x64";
  other.source.commit = "0".repeat(40);
  await assert.rejects(
    publicationPlan(fakeGitHub(receipt.source.commit).client, [receipt, other]),
    /one source commit/,
  );
});

test("annotated tags resolve to the verified commit", async () => {
  assert.equal(
    await tagCommit(
      {
        getTag: async () => ({ object: { type: "tag", sha: "tag-object" } }),
        getTagObject: async () => ({
          object: { type: "commit", sha: "verified" },
        }),
      },
      "v2.0.0",
    ),
    "verified",
  );
});

test("new releases stay draft until uploaded bytes and checksums are verified", async (t) => {
  const { root, receipt, bytes } = await fixture(t);
  const { client, state, blobs } = fakeGitHub(receipt.source.commit);
  const result = await publishVerified({
    root,
    receipts: [receipt],
    client,
    execute: true,
  });
  assert.equal(state.mutations[0][1].draft, true);
  assert.equal(state.mutations.at(-1)[0], "update");
  assert.equal(state.release.draft, false);
  assert.deepEqual(
    blobs.get(
      state.assets.find((asset) => asset.name === receipt.artifact.name).id,
    ),
    bytes,
  );
  assert.equal(result.status, "published-and-download-verified");
  state.mutations.length = 0;
  await publishVerified({ root, receipts: [receipt], client, execute: true });
  assert.deepEqual(
    state.mutations,
    [],
    "retry must not replace identical assets",
  );
});

test("checksum upload failure is resumable without rebuilding or reuploading the installer", async (t) => {
  const { root, receipt } = await fixture(t);
  const { client, state } = fakeGitHub(receipt.source.commit);
  state.failChecksums = true;
  await assert.rejects(
    publishVerified({ root, receipts: [receipt], client, execute: true }),
    /interruption/,
  );
  assert.equal(state.release.draft, true);
  state.failChecksums = false;
  state.mutations.length = 0;
  await publishVerified({ root, receipts: [receipt], client, execute: true });
  assert.deepEqual(
    state.mutations.filter(([kind]) => kind === "upload"),
    [["upload", "SHA256SUMS.txt"]],
  );
  assert.equal(state.release.draft, false);
});

test("adding a platform preserves the existing installer and combined checksums", async (t) => {
  const { root, receipt } = await fixture(t, "win-x64");
  const { client, state, add, blobs } = fakeGitHub(receipt.source.commit);
  await client.create({ draft: false, prerelease: false });
  const macBytes = Buffer.from("existing Mac installer");
  const mac = add("Passport-2.0.0-mac-arm64.dmg", macBytes);
  add("SHA256SUMS.txt", Buffer.from(`${sha256(macBytes)}  ${mac.name}\n`));
  state.mutations.length = 0;
  await publishVerified({ root, receipts: [receipt], client, execute: true });
  assert.equal(
    state.assets.find((asset) => asset.name === mac.name).id,
    mac.id,
  );
  const sums = blobs
    .get(state.assets.find((asset) => asset.name === "SHA256SUMS.txt").id)
    .toString();
  assert.ok(sums.includes(`${sha256(macBytes)}  ${mac.name}`));
  assert.ok(sums.includes(receipt.artifact.sha256));
  assert.ok(
    !state.mutations.some(([kind, id]) => kind === "remove" && id === mac.id),
  );
});

test("conflicting same-name assets and inconsistent old checksums stop publication", async (t) => {
  const { root, receipt } = await fixture(t);
  const { client, state, add } = fakeGitHub(receipt.source.commit);
  await client.create({ draft: false, prerelease: false });
  add(receipt.artifact.name, Buffer.from("different build"));
  state.mutations.length = 0;
  await assert.rejects(
    publishVerified({ root, receipts: [receipt], client, execute: true }),
    /different bytes/,
  );
  assert.deepEqual(state.mutations, []);
  add(
    "SHA256SUMS.txt",
    Buffer.from(`${"0".repeat(64)}  ${receipt.artifact.name}\n`),
  );
  await assert.rejects(
    publicationPlan(client, [receipt]),
    /checksum disagrees/,
  );
});

test("corrupted downloads leave new releases unpublished", async (t) => {
  const { root, receipt } = await fixture(t);
  const { client, state } = fakeGitHub(receipt.source.commit);
  state.corruptDownload = true;
  await assert.rejects(
    publishVerified({ root, receipts: [receipt], client, execute: true }),
    /download hash differs/,
  );
  assert.equal(state.release.draft, true);
});

test("immutable releases cannot receive a new installer", async (t) => {
  const { receipt } = await fixture(t);
  const { client, state } = fakeGitHub(receipt.source.commit);
  await client.create({ draft: false, immutable: true });
  state.release.immutable = true;
  await assert.rejects(publicationPlan(client, [receipt]), /immutable/);
});

test("an unexpected upload endpoint cannot receive credentials", async () => {
  let called = false;
  const client = githubClient("test-token", async () => {
    called = true;
  });
  await assert.rejects(
    client.upload(
      { upload_url: "https://unexpected.invalid/upload" },
      "file",
      Buffer.from("bytes"),
    ),
    /Unexpected GitHub endpoint/,
  );
  assert.equal(called, false);
});

test("concurrent local releases are rejected and the lock is released on failure", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(
    withReleaseLock(root, async () => {
      await assert.rejects(
        withReleaseLock(root, async () => {}),
        /Another local release/,
      );
      throw new Error("failed run");
    }),
    /failed run/,
  );
  await withReleaseLock(root, async () => {});
});

test("a hanging subprocess fails within its deadline", async () => {
  const start = Date.now();
  await assert.rejects(
    runCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeout: 150,
    }),
    /timeout/,
  );
  assert.ok(Date.now() - start < 5000);
});

test("an evidence path conflict stops before launching the subprocess", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-command-test-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const log = path.join(directory, "existing.log");
  const marker = path.join(directory, "started");
  await fs.writeFile(log, "original evidence");
  await assert.rejects(
    runCommand(
      process.execPath,
      [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], 'started')",
        marker,
      ],
      { log },
    ),
    { code: "EEXIST" },
  );
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
  assert.equal(await fs.readFile(log, "utf8"), "original evidence");
});

test("mistyped options cannot accidentally enable publication", () => {
  assert.throws(() => parseArguments(["--execut"]), /Unknown option/);
  assert.throws(() => parseArguments(["--manifest", "--execute"]), /needs/);
  assert.equal(
    parseArguments(["--manifest", "verification.json"]).execute,
    false,
  );
});

test("Electron teardown checks actual process exit after the platform's graceful close", async () => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    stderr: new PassThrough(),
  });
  let cleanupFinished = false;
  const app = {
    process: () => child,
    evaluate: async () => {
      cleanupFinished = true;
    },
    close: async () => {
      assert.equal(cleanupFinished, true);
      assert.equal(child.exitCode, null);
      child.exitCode = 0;
      child.emit("exit", 0, null);
    },
  };
  await closeCleanly(app, 1000);
  assert.equal(child.exitCode, 0);
});

test("Electron teardown rejects a stalled quit instead of waiting indefinitely", async () => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    stderr: new PassThrough(),
  });
  let closed = false;
  const app = {
    process: () => child,
    evaluate: async () => new Promise(() => {}),
    close: async () => {
      closed = true;
    },
  };
  await assert.rejects(closeCleanly(app, 50), /normal shutdown exceeded/);
  assert.equal(closed, false);
  child.emit("exit", 0, null);
});

test("Electron teardown holds the final quit until cleanup and debugger close are ordered", async () => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    stderr: new PassThrough(),
  });
  let cleaned = false;
  let debuggerClosed = false;
  const nativeApp = Object.assign(new EventEmitter(), {
    quit() {
      const event = {
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      nativeApp.emit("will-quit", event);
      if (!event.defaultPrevented) {
        assert.equal(cleaned, true);
        assert.equal(debuggerClosed, true);
        child.exitCode = 0;
        child.emit("exit", 0, null);
      }
    },
  });
  nativeApp.on("will-quit", (event) => {
    if (cleaned) return;
    event.preventDefault();
    setTimeout(() => {
      cleaned = true;
      nativeApp.quit();
    }, 5);
  });
  const application = {
    process: () => child,
    evaluate: (fn) => fn({ app: nativeApp, dialog: {} }),
    close: async () => {
      assert.equal(cleaned, true);
      assert.equal(child.exitCode, null);
      debuggerClosed = true;
      nativeApp.quit();
    },
  };
  await closeCleanly(application, 1000);
  assert.equal(child.exitCode, 0);
  assert.equal(nativeApp.listenerCount("will-quit"), 1);
});

test("a forced Electron exit is never accepted as a normal shutdown", async () => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    stderr: new PassThrough(),
  });
  const app = {
    process: () => child,
    evaluate: async () => {
      child.signalCode = "SIGKILL";
      child.emit("exit", null, "SIGKILL");
    },
    close: async () => {},
  };
  await assert.rejects(closeCleanly(app, 1000), /Electron must exit normally/);
});

test("E2E defaults to hidden and rejects unrecognized modes", () => {
  assert.equal(e2eMode({}), "hidden");
  for (const mode of ["hidden", "passive", "desktop"])
    assert.equal(e2eMode({ PASSPORT_E2E_MODE: mode }), mode);
  assert.throws(() => e2eMode({ PASSPORT_E2E_MODE: "typo" }), /Unknown/);
});

for (const audit of [
  { mode: "hidden", shown: 1, focused: 0 },
  { mode: "passive", shown: 1, focused: 1 },
])
  test(`E2E teardown rejects desktop interference: ${JSON.stringify(audit)}`, async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      stderr: new PassThrough(),
    });
    let closed = false;
    const app = {
      process: () => child,
      evaluate: async () => {
        child.exitCode = 0;
        child.emit("exit", 0, null);
        return audit;
      },
      close: async () => {
        closed = true;
      },
    };
    await assert.rejects(closeCleanly(app, 1000), /must never/);
    assert.equal(
      closed,
      true,
      "The app must still close before reporting an audit failure",
    );
  });

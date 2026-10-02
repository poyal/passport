import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = fileURLToPath(new URL("..", import.meta.url));
export const guiCheckModes = {
  "source-gui": "hidden",
  "source-desktop": "desktop",
  "packaged-gui": "hidden",
  "packaged-desktop": "desktop",
};
const optionalFeatures = ["docker", "stress", "throughput"];
export function requestedGuiFeatures(env = process.env) {
  return [
    ...(env.PASSPORT_DOCKER_MANIFEST ? ["docker"] : []),
    ...(env.PASSPORT_UI_STRESS === "1" ? ["stress"] : []),
    ...(env.PASSPORT_TEXT_BENCH === "1" ? ["throughput"] : []),
  ];
}
export function loadGuiPolicy(root = defaultRoot) {
  const policy = JSON.parse(
    readFileSync(path.join(root, "tests/e2e/release-policy.json"), "utf8"),
  );
  assert.equal(policy.schemaVersion, 1, "Unknown GUI policy format");
  assert.ok(
    Array.isArray(policy.tests) && policy.tests.length > 0,
    "Empty GUI policy",
  );
  const ids = new Set(),
    keys = new Set();
  for (const entry of policy.tests) {
    assert.ok(
      typeof entry.id === "string" && entry.id && !ids.has(entry.id),
      "Duplicate or missing policy test ID",
    );
    assert.ok(
      typeof entry.file === "string" &&
        typeof entry.title === "string" &&
        entry.title,
      "Missing policy test name",
    );
    assert.ok(
      [undefined, "hidden", "desktop"].includes(entry.mode),
      "Unknown policy mode",
    );
    assert.ok(
      entry.optional === undefined || optionalFeatures.includes(entry.optional),
      "Unknown optional GUI feature",
    );
    assert.ok(
      (entry.platforms || ["darwin", "win32"]).every((platform) =>
        ["darwin", "win32"].includes(platform),
      ) && entry.platforms?.length !== 0,
      "Invalid policy platforms",
    );
    const key = `${entry.file}\0${entry.title}`;
    assert.ok(!keys.has(key), "Duplicate policy test name");
    ids.add(entry.id);
    keys.add(key);
  }
  // Canonical JSON is independent of checkout line endings across OSes.
  return {
    policy,
    hash: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
  };
}

export function reportSpecs(report) {
  assert.ok(Array.isArray(report.suites), "GUI report has no suites");
  const specs = [];
  const visit = (suites) => {
    for (const suite of suites) {
      specs.push(...(suite.specs || []));
      visit(suite.suites || []);
    }
  };
  visit(report.suites);
  return specs;
}
const keyFor = (spec) =>
  `${spec.file.replaceAll("\\", "/").replace(/^.*tests\/e2e\//, "")}\0${spec.title.replace(/\s+@desktop$/, "")}`;

export function validateGuiReport(
  report,
  { platform, mode, optional = [] },
  { policy, hash } = loadGuiPolicy(),
  discovery = false,
) {
  assert.ok(["darwin", "win32"].includes(platform), "Unsupported GUI platform");
  assert.ok(
    ["hidden", "desktop"].includes(mode),
    "Release GUI must use hidden or desktop mode",
  );
  assert.ok(
    Array.isArray(optional) &&
      new Set(optional).size === optional.length &&
      optional.every((name) => optionalFeatures.includes(name)),
    "Invalid optional GUI features",
  );
  assert.equal(
    report.errors?.length || 0,
    0,
    "GUI report contains global errors",
  );
  const entries = policy.tests.filter(
    (entry) => (entry.mode || "hidden") === mode,
  );
  assert.ok(entries.length > 0, `No GUI policy entries for ${mode}`);
  const specs = reportSpecs(report);
  const byKey = new Map();
  for (const spec of specs) {
    const key = keyFor(spec);
    assert.ok(!byKey.has(key), `Duplicate GUI test: ${key}`);
    byKey.set(key, spec);
  }
  assert.deepEqual(
    [...byKey.keys()].sort(),
    entries.map(keyFor).sort(),
    "GUI test inventory differs: a required test is missing, renamed, filtered out, or an unreviewed test was added",
  );
  const tests = [];
  for (const entry of entries) {
    const spec = byKey.get(keyFor(entry));
    assert.equal(
      spec.tests?.length,
      1,
      `Expected one project/repetition for ${entry.id}`,
    );
    const test = spec.tests[0];
    if (discovery) continue;
    assert.equal(
      test.results?.length,
      1,
      `Missing result or retried GUI test: ${entry.id}`,
    );
    const result = test.results[0];
    assert.equal(result.retry ?? 0, 0, `Retried GUI test: ${entry.id}`);
    assert.equal(result.errors?.length || 0, 0, `GUI test errors: ${entry.id}`);
    assert.ok(!result.error, `GUI test error: ${entry.id}`);
    const reason = !(entry.platforms || ["darwin", "win32"]).includes(platform)
      ? `not applicable on ${platform}`
      : entry.optional && !optional.includes(entry.optional)
        ? `optional feature not requested: ${entry.optional}`
        : null;
    if (!reason) {
      assert.equal(
        test.expectedStatus,
        "passed",
        `Required GUI test was skipped or marked as an expected failure: ${entry.id}`,
      );
      assert.equal(
        result.status,
        "passed",
        `Required GUI test did not pass: ${entry.id}`,
      );
      assert.equal(
        test.status,
        "expected",
        `GUI test is not a clean pass: ${entry.id}`,
      );
    } else {
      assert.ok(
        ["passed", "skipped"].includes(result.status),
        `Allowed-optional test failed: ${entry.id}`,
      );
      assert.equal(
        test.expectedStatus,
        result.status,
        `Unexpected optional GUI result: ${entry.id}`,
      );
      assert.equal(
        test.status,
        result.status === "passed" ? "expected" : "skipped",
        `Inconsistent optional GUI result: ${entry.id}`,
      );
    }
    tests.push({
      id: entry.id,
      file: entry.file,
      title: entry.title,
      status: result.status,
      required: !reason,
      skipReason: result.status === "skipped" ? reason : null,
    });
  }
  if (discovery) return { policyHash: hash, mode, discovered: specs.length };
  const passed = tests.filter((test) => test.status === "passed").length;
  const skipped = tests.length - passed;
  assert.ok(passed > 0, "GUI suite did not execute any passing test");
  assert.equal(
    report.stats?.expected,
    passed,
    "GUI passed count disagrees with individual results",
  );
  assert.equal(
    report.stats?.skipped,
    skipped,
    "GUI skipped count disagrees with individual results",
  );
  assert.equal(report.stats?.unexpected, 0, "Unexpected GUI failures");
  assert.equal(report.stats?.flaky, 0, "Flaky GUI results are not releasable");
  return {
    policyHash: hash,
    platform,
    mode,
    optional: [...optional].sort(),
    passed,
    skipped,
    tests,
  };
}

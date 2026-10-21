import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Requested on 2026-10-21 after the original Windows failures were explained.
// Only these unpublished Windows installers may use a separate source tag.
export const windowsBackfills = Object.freeze([
  Object.freeze({
    version: "1.3.0",
    target: "win-x64",
    releaseCommit: "359e207a11006446d786ee55bab94d0f874fdc03",
    sourceTag: "v1.3.0-win-x64",
    files: [
      "tests/e2e/sharing.spec.ts",
      "src/main/platform/win32/download.ts",
      "tests/share.test.ts",
    ],
    macAsset: {
      id: 646613918,
      name: "Passport-1.3.0-mac-arm64.dmg",
      size: 170831382,
      digest:
        "sha256:baa2e5374025b6f288331a8dcab798f8e32256a2460f35b78c1f0ec181d98fb9",
    },
  }),
  Object.freeze({
    version: "1.3.4",
    target: "win-x64",
    releaseCommit: "3b54357fe6a34432ead722a40fb38bc2ca50e10f",
    sourceTag: "v1.3.4-win-x64",
    files: ["src/renderer/styles.css", "tests/e2e/scroll-workspaces.spec.ts"],
    macAsset: {
      id: 658414941,
      name: "Passport-1.3.4-mac-arm64.dmg",
      size: 173619402,
      digest:
        "sha256:5cf5b866356be339fd2df9458268af7a61b27d73848046b05f8d3798b5d95967",
    },
  }),
]);

export function windowsBackfillSource(receipt) {
  return windowsBackfills.find(
    (entry) =>
      receipt.version === entry.version &&
      receipt.target === entry.target &&
      receipt.source.commit !== entry.releaseCommit,
  );
}

export function assertBackfillSource(root, policy, commit) {
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  git("merge-base", "--is-ancestor", policy.releaseCommit, commit);
  const allowed = new Set([
    ...policy.files,
    "scripts/windows-backfill.mjs",
    "scripts/release-core.mjs",
    "scripts/release-publish.mjs",
    "tests/release.test.mjs",
  ]);
  const changed = git("diff", "--name-only", "-z", policy.releaseCommit, commit)
    .split("\0")
    .filter(Boolean);
  assert.ok(
    changed.every((file) => allowed.has(file) || /^docs\/.*\.md$/.test(file)),
    `Windows ${policy.version} source includes changes outside its approved repair, publication and documentation scope`,
  );
}

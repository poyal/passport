import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

const dryRun = process.env.PASSPORT_RELEASE_DRY_RUN === "1";
const repo = process.env.GITHUB_REPOSITORY || "poyal/passport";
assert.equal(repo, "poyal/passport", "Unexpected release repository");
const version = JSON.parse(await fs.readFile("package.json", "utf8")).version;
assert.match(version, /^\d+\.\d+\.\d+$/);
if (!dryRun) {
  assert.equal(
    process.env.GITHUB_ACTIONS,
    "true",
    "Publish through the verified Actions workflow",
  );
  assert.ok(
    process.env.GITHUB_REF === "refs/heads/main" ||
      process.env.GITHUB_REF === `refs/tags/v${version}`,
    "Publish from main or the matching stable release tag",
  );
  assert.ok(process.env.GH_TOKEN, "The workflow needs a repository token");
}
const name = `Passport-${version}-win-x64.exe`;
const installer = process.env.PASSPORT_RELEASE_INSTALLER || `release/${name}`;
const bytes = (await fs.stat(installer)).size;
const hash = createHash("sha256");
for await (const chunk of createReadStream(installer)) hash.update(chunk);
const digest = hash.digest("hex");
const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "Passport-Windows-release",
  "X-GitHub-Api-Version": "2022-11-28",
  ...(process.env.GH_TOKEN
    ? { Authorization: `Bearer ${process.env.GH_TOKEN}` }
    : {}),
};
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  if (!response.ok)
    throw new Error(
      `GitHub ${options.method || "GET"} failed (${response.status}): ${(await response.text()).slice(0, 300)}`,
    );
  return response.status === 204 ? undefined : response.json();
}
const release = await api(
  `https://api.github.com/repos/${repo}/releases/tags/v${version}`,
);
assert.equal(release.draft, false);
assert.equal(release.prerelease, false);
assert.equal(release.immutable, false, "The existing release is immutable");
const existing = release.assets.find((asset) => asset.name === name);
if (existing)
  assert.equal(
    existing.digest,
    `sha256:${digest}`,
    "An installer with different bytes already exists",
  );
const sumsAsset = release.assets.find(
  (asset) => asset.name === "SHA256SUMS.txt",
);
assert.ok(sumsAsset, "The existing Mac checksum file must be preserved");
const sumsResponse = await fetch(sumsAsset.browser_download_url);
assert.ok(sumsResponse.ok, "Could not download existing checksums");
const originalSums = await sumsResponse.text();
const entries = originalSums.trim().split(/\r?\n/).filter(Boolean);
for (const line of entries) assert.match(line, /^[a-f0-9]{64} {2}\S+$/i);
const mac = release.assets.find(
  (asset) => asset.name === `Passport-${version}-mac-arm64.dmg`,
);
assert.ok(mac);
assert.ok(
  entries.includes(`${mac.digest.replace(/^sha256:/, "")}  ${mac.name}`),
  "Mac checksum and public asset digest differ",
);
const sums =
  entries
    .filter((line) => line.split(/ {2}/)[1] !== name)
    .concat(`${digest}  ${name}`)
    .join("\n") + "\n";
await fs.writeFile("release/SHA256SUMS.txt", sums);
const uploadBase = release.upload_url.replace(/\{.*$/, "");
assert.equal(new URL(uploadBase).hostname, "uploads.github.com");
async function upload(assetName, body, length, contentType) {
  return api(`${uploadBase}?name=${encodeURIComponent(assetName)}`, {
    method: "POST",
    body,
    duplex: "half",
    headers: { "Content-Type": contentType, "Content-Length": String(length) },
  });
}
if (dryRun) {
  console.log(
    JSON.stringify(
      {
        dryRun: true,
        release: release.html_url,
        installer,
        bytes,
        digest,
        existingMacPreserved: true,
        checksumEntries: sums.trim().split("\n"),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
const uploaded =
  existing ||
  (await upload(
    name,
    createReadStream(installer),
    bytes,
    "application/octet-stream",
  ));
assert.equal(uploaded.size, bytes);
assert.equal(uploaded.digest, `sha256:${digest}`);
if (sums !== originalSums) {
  await api(sumsAsset.url, { method: "DELETE" });
  try {
    await upload(
      "SHA256SUMS.txt",
      Buffer.from(sums),
      Buffer.byteLength(sums),
      "text/plain",
    );
  } catch (error) {
    await upload(
      "SHA256SUMS.txt",
      Buffer.from(originalSums),
      Buffer.byteLength(originalSums),
      "text/plain",
    );
    throw error;
  }
}
const heading = "## Windows x64 설치본 추가";
const sourceURL = `https://github.com/${repo}/commit/${process.env.GITHUB_SHA}`;
const note = `${heading}\n\nWindows 11 x64용 설치 프로그램을 추가했습니다. 현재 사용자 전용으로 설치하며 설치 폴더 선택을 지원합니다. 내장 Passport Bash를 포함하며 Git Bash를 따로 설치할 필요가 없습니다.\n\n기본 검사, 현재 사용자 설치 범위, 패키지 PTY·GUI·실제 DPAPI 검증을 통과했습니다. 실제 AI 서비스의 대화형 승인과 OS 배너 표시는 별도 기기 확인이 필요합니다. EXE는 코드 서명되지 않았습니다. SHA256SUMS.txt에는 Mac과 Windows 체크섬을 함께 제공합니다.\n\nWindows 설치본 소스: [${process.env.GITHUB_SHA.slice(0, 7)}](${sourceURL}).\n`;
const body = (release.body || "").split(heading)[0].trimEnd() + "\n\n" + note;
await api(release.url, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ body }),
});
const download = await fetch(uploaded.browser_download_url);
assert.ok(download.ok, "Could not download the published installer");
const publicHash = createHash("sha256");
let publicBytes = 0;
for await (const chunk of download.body) {
  publicHash.update(chunk);
  publicBytes += chunk.length;
}
assert.equal(publicBytes, bytes);
assert.equal(publicHash.digest("hex"), digest);
const record = {
  version,
  releaseURL: release.html_url,
  sourceCommit: process.env.GITHUB_SHA,
  workflowRun: process.env.GITHUB_RUN_ID,
  publishedAt: new Date().toISOString(),
  artifact: {
    name,
    bytes,
    sha256: digest,
    downloadURL: uploaded.browser_download_url,
  },
  publicDownloadVerified: true,
  macDigestPreserved: mac.digest,
  combinedChecksums: true,
};
await fs.writeFile(
  "release/windows-published.json",
  JSON.stringify(record, null, 2) + "\n",
);
console.log(JSON.stringify(record, null, 2));

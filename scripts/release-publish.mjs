import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  repository,
  sha256,
  validateReceipt,
  sourceState,
  parseArguments,
  withReleaseLock,
  writeJSON,
} from "./release-core.mjs";

const installerPattern =
  /^Passport-\d+\.\d+\.\d+-(mac-arm64\.dmg|win-(x64|arm64)\.exe)$/;
const sumsName = "SHA256SUMS.txt";

export function githubClient(token, fetcher = fetch) {
  const base = `https://api.github.com/repos/${repository}`;
  async function request(
    url,
    { method = "GET", body, binary = false, allow404 = false } = {},
  ) {
    assert.ok(
      url.startsWith(`${base}/`) ||
        url.startsWith(`https://uploads.github.com/repos/${repository}/`),
      "Unexpected GitHub endpoint",
    );
    const response = await fetcher(url, {
      method,
      redirect: "follow",
      signal: AbortSignal.timeout(180000),
      headers: {
        Accept: binary
          ? "application/octet-stream"
          : "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Passport-local-release",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined
          ? {
              "Content-Type": Buffer.isBuffer(body)
                ? "application/octet-stream"
                : "application/json",
            }
          : {}),
      },
      ...(body !== undefined
        ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }
        : {}),
    });
    if (allow404 && response.status === 404) return null;
    assert.ok(response.ok, `GitHub ${method} failed (${response.status})`);
    if (response.status === 204) return null;
    return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
  }
  return {
    getTag: (tag) => request(`${base}/git/ref/tags/${encodeURIComponent(tag)}`),
    getTagObject: (sha) => request(`${base}/git/tags/${sha}`),
    getRelease: (tag) =>
      request(`${base}/releases/tags/${encodeURIComponent(tag)}`, {
        allow404: true,
      }),
    getAssets: async (id) => {
      const assets = [];
      for (let page = 1; page <= 10; page++) {
        const items = await request(
          `${base}/releases/${id}/assets?per_page=100&page=${page}`,
        );
        assets.push(...items);
        if (items.length < 100) return assets;
      }
      throw new Error("Too many release assets");
    },
    download: (asset) =>
      request(`${base}/releases/assets/${asset.id}`, { binary: true }),
    create: (data) =>
      request(`${base}/releases`, { method: "POST", body: data }),
    update: (id, data) =>
      request(`${base}/releases/${id}`, { method: "PATCH", body: data }),
    remove: (id) =>
      request(`${base}/releases/assets/${id}`, { method: "DELETE" }),
    upload: (release, name, bytes) =>
      request(
        `${release.upload_url.replace(/\{.*$/, "")}?name=${encodeURIComponent(name)}`,
        { method: "POST", body: bytes },
      ),
  };
}

export async function tagCommit(client, tag) {
  let { object } = await client.getTag(tag);
  for (let depth = 0; object.type === "tag" && depth < 5; depth++)
    object = (await client.getTagObject(object.sha)).object;
  assert.equal(object.type, "commit", "Release tag must resolve to a commit");
  return object.sha;
}

export async function publicationPlan(client, receipts) {
  assert.ok(receipts.length, "At least one verification receipt is required");
  const { version, source } = receipts[0];
  assert.equal(
    new Set(receipts.map((receipt) => receipt.target)).size,
    receipts.length,
    "Duplicate platform receipts",
  );
  for (const receipt of receipts) {
    assert.equal(
      receipt.version,
      version,
      "All installers must have one version",
    );
    assert.equal(
      receipt.source.commit,
      source.commit,
      "All installers must come from one source commit",
    );
  }
  const tag = `v${version}`;
  assert.equal(
    await tagCommit(client, tag),
    source.commit,
    "Remote tag differs from the verified commit. Push the matching tag; never move an existing release tag.",
  );
  const release = await client.getRelease(tag);
  assert.ok(
    !release?.prerelease,
    "A stable release cannot update a prerelease",
  );
  const assets = release ? await client.getAssets(release.id) : [];
  assert.equal(
    new Set(assets.map((asset) => asset.name)).size,
    assets.length,
    "Duplicate remote asset names",
  );
  const installers = assets.filter((asset) =>
    installerPattern.test(asset.name),
  );
  const entries = new Map();
  for (const asset of installers) {
    assert.ok(
      asset.name.startsWith(`Passport-${version}-`),
      "Unexpected installer version on release",
    );
    assert.equal(
      asset.state,
      "uploaded",
      `Remote asset is incomplete: ${asset.name}`,
    );
    assert.match(
      asset.digest || "",
      /^sha256:[a-f0-9]{64}$/,
      `Remote asset digest missing: ${asset.name}`,
    );
    entries.set(asset.name, asset.digest.slice(7));
  }
  const existingSums = assets.find((asset) => asset.name === sumsName);
  let oldSums;
  if (existingSums) {
    oldSums = await client.download(existingSums);
    const seen = new Set();
    for (const line of oldSums
      .toString("utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)) {
      const match = /^([a-f0-9]{64}) {2}(\S+)$/.exec(line);
      assert.ok(match && !seen.has(match[2]), "Malformed remote checksums");
      assert.equal(
        entries.get(match[2]),
        match[1],
        "Existing checksum disagrees with its remote installer; investigate before publishing.",
      );
      seen.add(match[2]);
    }
  }
  const uploads = [];
  for (const receipt of receipts) {
    const { artifact } = receipt;
    const existing = assets.find((asset) => asset.name === artifact.name);
    if (existing) {
      assert.equal(
        existing.digest,
        `sha256:${artifact.sha256}`,
        `An installer with different bytes already exists: ${artifact.name}`,
      );
      assert.equal(
        existing.size,
        artifact.bytes,
        "Remote installer size differs",
      );
    } else uploads.push(artifact.name);
    entries.set(artifact.name, artifact.sha256);
  }
  const sums = Buffer.from(
    [...entries]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, digest]) => `${digest}  ${name}\n`)
      .join(""),
  );
  const updateSums = !oldSums?.equals(sums);
  assert.ok(
    !release?.immutable || (!uploads.length && !updateSums),
    "This release is immutable; use a new version.",
  );
  return { tag, release, assets, uploads, sums, existingSums, updateSums };
}

export async function publishVerified({
  root,
  receipts,
  client,
  execute = false,
}) {
  const state = await sourceState(root);
  const filenames = [];
  for (const receipt of receipts)
    filenames.push(await validateReceipt(root, receipt, state));
  const plan = await publicationPlan(client, receipts);
  const summary = {
    mode: execute ? "publish" : "dry-run",
    tag: plan.tag,
    sourceCommit: state.commit,
    targets: receipts.map((receipt) => receipt.target),
    upload: plan.uploads,
    preserve: plan.assets
      .filter((asset) => asset.name !== sumsName)
      .map((asset) => asset.name),
    updateChecksums: plan.updateSums,
    createDraft: !plan.release,
    publishDraft: !plan.release || plan.release.draft,
  };
  if (!execute) return summary;
  const notes = await fs.readFile(
    path.join(root, "docs/releases", `${plan.tag}.md`),
    "utf8",
  );
  // Recheck immediately before the first remote mutation; never rebuild here.
  for (const receipt of receipts) await validateReceipt(root, receipt);
  let release =
    plan.release ||
    (await client.create({
      tag_name: plan.tag,
      target_commitish: state.commit,
      name: `Passport ${receipts[0].version}`,
      body: notes,
      draft: true,
      prerelease: false,
    }));
  for (let index = 0; index < receipts.length; index++) {
    const { artifact } = receipts[index];
    // Buffer the exact verified bytes, so a concurrent file edit cannot alter
    // the bytes being streamed into GitHub after the final hash check.
    const bytes = await fs.readFile(filenames[index]);
    assert.equal(
      sha256(bytes),
      artifact.sha256,
      "Installer changed before upload",
    );
    const asset = plan.uploads.includes(artifact.name)
      ? await client.upload(release, artifact.name, bytes)
      : plan.assets.find((item) => item.name === artifact.name);
    assert.equal(
      sha256(await client.download(asset)),
      artifact.sha256,
      "Uploaded installer download hash differs",
    );
  }
  // Detect simultaneous platform publishers before touching shared checksums.
  const current = await client.getAssets(release.id);
  const expectedNames = new Set([
    ...plan.assets
      .filter((asset) => installerPattern.test(asset.name))
      .map((asset) => asset.name),
    ...receipts.map((receipt) => receipt.artifact.name),
  ]);
  const currentNames = current
    .filter((asset) => installerPattern.test(asset.name))
    .map((asset) => asset.name);
  assert.deepEqual(
    [...currentNames].sort(),
    [...expectedNames].sort(),
    "Another publisher changed this release; rerun the plan before updating checksums.",
  );
  for (const asset of plan.assets) {
    const unchanged = current.find((item) => item.name === asset.name);
    for (const key of ["id", "name", "size", "digest", "state", "updated_at"])
      assert.equal(
        unchanged?.[key],
        asset[key],
        "A remote asset changed during publication; retry after reviewing the release.",
      );
  }
  if (plan.updateSums) {
    if (plan.existingSums) await client.remove(plan.existingSums.id);
    const asset = await client.upload(release, sumsName, plan.sums);
    assert.equal(
      sha256(await client.download(asset)),
      sha256(plan.sums),
      "Checksum download differs",
    );
  }
  // A failed upload leaves a resumable draft (or preserves existing installers).
  // A retry reconstructs checksums from verified GitHub asset digests.
  for (const receipt of receipts) await validateReceipt(root, receipt);
  assert.equal(
    await tagCommit(client, plan.tag),
    state.commit,
    "Remote tag changed during publication; keep the draft and investigate.",
  );
  if (release.draft)
    release = await client.update(release.id, {
      draft: false,
      make_latest: "true",
    });
  return {
    ...summary,
    status: "published-and-download-verified",
    url: release.html_url,
    finishedAt: new Date().toISOString(),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(
      "npm run release:publish -- --manifest release/checks/<run>/verification.json [--manifest <other-platform>] [--execute]\nDefault: read-only GitHub plan. --execute uploads the exact verified installers and publishes the release. Never rebuilds, pushes source, or creates/moves tags.",
    );
    return;
  }
  assert.ok(
    !options.preview && !options.desktop,
    "--preview and --desktop belong to release:verify, not release:publish",
  );
  assert.ok(
    options.manifests.length,
    "Pass --manifest release/checks/<run>/verification.json",
  );
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const receipts = await Promise.all(
    options.manifests.map(async (file) =>
      JSON.parse(await fs.readFile(path.resolve(file), "utf8")),
    ),
  );
  let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    try {
      token = execFileSync("gh", ["auth", "token"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      /* public dry-run needs no token */
    }
  }
  assert.ok(
    !options.execute || token,
    "Authenticate with gh auth login or provide GH_TOKEN before --execute",
  );
  await withReleaseLock(root, async () => {
    const result = await publishVerified({
      root,
      receipts,
      client: githubClient(token),
      execute: options.execute,
    });
    console.log(JSON.stringify(result, null, 2));
    if (options.execute) {
      for (const receipt of receipts) {
        const directory = path.join(
          root,
          "release/packages",
          `v${receipt.version}`,
          "local",
          receipt.target,
        );
        await fs.mkdir(directory, { recursive: true });
        const destination = path.join(directory, receipt.artifact.name);
        // Preserve any existing local package with a different provenance.
        try {
          await fs.copyFile(
            path.join(root, receipt.artifact.path),
            destination,
            (await import("node:fs")).constants.COPYFILE_EXCL,
          );
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          assert.equal(
            sha256(await fs.readFile(destination)),
            receipt.artifact.sha256,
            "Package archive conflict; published installer is unchanged",
          );
        }
        await writeJSON(path.join(directory, "artifact.json"), {
          createdAt: new Date().toISOString(),
          purpose: "published-local-release",
          source: "local",
          sourceCommit: receipt.source.commit,
          dirty: false,
          platform: receipt.target,
          status: "success",
          artifact: receipt.artifact,
          publication: result,
        });
      }
    }
  });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

// Requires two real packaged versions built with the same update public key.
// Both the installation and the application profile are isolated copies.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { electron } from "../../scripts/e2e-electron.mjs";
import { closeCleanly } from "../fixtures/electron-exit.ts";

const flowOnly = process.argv.includes("--flow-only");
const [previousApp, packageDirectory, reportFile] = process.argv
  .slice(2)
  .filter((a) => a !== "--flow-only");
if (!previousApp || !packageDirectory)
  throw new Error(
    "Usage: node scripts/verify-installed-update.mjs <previous-app-directory> <signed-update-directory>",
  );
const target = `${process.platform}-${process.arch}`;
const metadataName = `update-${target}.json`,
  signatureName = `update-${target}.sig`;
const metadata = await fs.readFile(path.join(packageDirectory, metadataName));
const manifest = JSON.parse(metadata);
const payloadName = manifest.platforms[target].name;
const payloads = {};
for (const name of [metadataName, signatureName, payloadName])
  payloads[name] = (await fs.stat(path.join(packageDirectory, name))).size;
// Stream the real signed ZIP through loopback, rather than copying a whole
// archive through the debugger protocol and multiple base64 buffers.
const server = createServer((request, response) => {
  const name = request.url?.slice(1);
  if (!Object.hasOwn(payloads, name)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "Content-Length": payloads[name] });
  const file = createReadStream(path.join(packageDirectory, name));
  file.on("error", () => response.destroy());
  response.on("close", () => file.destroy());
  file.pipe(response);
});
const root = path.resolve("release/checks", `installed-update-${randomUUID()}`);
const install = path.join(
    root,
    process.platform === "darwin" ? "Passport.app" : "Passport",
  ),
  data = path.join(root, "data");
await fs.mkdir(root, { recursive: true });
await fs.cp(await fs.realpath(previousApp), install, {
  recursive: true,
  verbatimSymlinks: true,
});
await fs.mkdir(data);
const executable = path.join(
  install,
  process.platform === "win32" ? "Passport.exe" : "Contents/MacOS/Passport",
);
let app;
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const fixtureURL = `http://127.0.0.1:${server.address().port}`;
  app = await electron.launch({
    executablePath: executable,
    args: [],
    env: {
      ...process.env,
      PASSPORT_DATA_DIR: data,
      PASSPORT_DISABLE_UPDATE_CHECK: "1",
      PASSPORT_E2E_WINDOW_MODE: "hidden",
      PASSPORT_E2E_UPDATE: "1",
      PASSPORT_E2E_UPDATE_FLOW_ONLY: flowOnly ? "1" : "0",
    },
    timeout: 30000,
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".home-view");
  const oldVersion = await app.evaluate(({ app }) => app.getVersion());
  assert.notEqual(
    oldVersion,
    manifest.version,
    "The test must cross real application versions",
  );
  if (!flowOnly) {
    const encrypted = await app.evaluate(({ safeStorage }) =>
      safeStorage.encryptString("passport-update-test").toString("base64"),
    );
    await fs.writeFile(
      path.join(data, "update-test-secret"),
      Buffer.from(encrypted, "base64"),
    );
  }
  await app.evaluate(
    async ({ net, dialog }, { payloads, version, fixtureURL }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
      const original = net.fetch.bind(net);
      net.fetch = async (url, init) => {
        const name = String(url).split("/").at(-1);
        if (
          String(url) ===
          "https://api.github.com/repos/poyal/passport/releases/latest"
        )
          return Response.json({
            tag_name: `v${version}`,
            draft: false,
            prerelease: false,
            assets: Object.keys(payloads).map((name) => ({
              name,
              state: "uploaded",
              size: payloads[name],
              browser_download_url: `https://github.com/poyal/passport/releases/download/v${version}/${name}`,
            })),
          });
        if (
          String(url).startsWith(
            `https://github.com/poyal/passport/releases/download/v${version}/`,
          ) &&
          payloads[name]
        ) {
          const response = await original(`${fixtureURL}/${name}`, init);
          return new Response(response.body, {
            status: response.status,
            headers: response.headers,
          });
        }
        return original(url, init);
      };
    },
    { payloads, version: manifest.version, fixtureURL },
  );
  const before = await page.evaluate(
    async ({ hostId, profileId, flowOnly }) => {
      if (!flowOnly)
        await window.passport.call("auth.save", {
          id: profileId,
          name: "Update credential fixture",
          username: "tester",
          secret: {
            type: "password",
            password: "test-only-password",
            privateKey: "",
            passphrase: "",
          },
        });
      const { document } = await window.passport.call("bootstrap");
      document.settings.terminal.profileIds = ["unix-shortcuts"];
      document.hosts = [
        {
          id: hostId,
          name: "Update host fixture",
          address: "127.0.0.1",
          port: 22,
          username: "tester",
          authId: flowOnly ? null : profileId,
        },
      ];
      await window.passport.call("save", document);
      return (await window.passport.call("bootstrap")).document;
    },
    { hostId: randomUUID(), profileId: randomUUID(), flowOnly },
  );
  await page.evaluate(() => window.passport.call("updates.check"));
  const state = await page.evaluate(
    async () => (await window.passport.call("bootstrap")).updateState,
  );
  assert.equal(
    state.inAppAvailable,
    true,
    "Candidate must have an embedded update public key",
  );
  await page.evaluate(() => window.passport.call("updates.download"));
  assert.equal(
    (
      await page.evaluate(
        async () => (await window.passport.call("bootstrap")).updateState,
      )
    ).installation.phase,
    "ready",
  );
  console.log("Signed download verified; requesting the old app to exit");
  await closeCleanly(app, 10000, () =>
    page
      .evaluate(() => window.passport.call("updates.install"))
      .catch((error) => {
        // The install request closes the renderer; its IPC reply may lose that
        // race. closeCleanly still requires native cleanup and a real code-0 exit.
        if (
          !error.message.includes(
            "Target page, context or browser has been closed",
          )
        )
          throw error;
      }),
  );
  app = undefined;
  console.log("Old application exited normally; waiting for the updated app");
  const ids = await fs.readdir(path.join(data, "updates"));
  assert.equal(ids.length, 1);
  const transaction = path.join(data, "updates", ids[0]);
  const deadline = Date.now() + 120000;
  let report;
  while (Date.now() < deadline) {
    try {
      report = JSON.parse(
        await fs.readFile(path.join(transaction, "startup-test.json"), "utf8"),
      );
      break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(
    report,
    "Updated app did not report startup (check OS Keychain prompts separately)",
  );
  assert.equal(report.version, manifest.version);
  assert.equal(report.secretRestored, flowOnly ? null : true);
  assert.equal(report.windows.shown, 0);
  assert.equal(report.windows.focused, 0);
  const childPid = Number(
    await fs.readFile(path.join(transaction, "child.pid"), "utf8"),
  );
  assert.ok(Number.isInteger(childPid) && childPid > 0);
  const exited = () => {
    try {
      process.kill(childPid, 0);
      return false;
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
  };
  const exitDeadline = Date.now() + 10000;
  while (!exited() && Date.now() < exitDeadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(exited(), "Updated test app did not shut down before relaunch");
  assert.match(
    await fs.readFile(path.join(transaction, "journal.jsonl"), "utf8"),
    /"state":"complete"/,
  );
  console.log(
    "Updated application reported healthy startup; verifying persisted data",
  );
  // Reopen through the normal app path to verify persisted application state.
  app = await electron.launch({
    executablePath: executable,
    args: [],
    env: {
      ...process.env,
      PASSPORT_DATA_DIR: data,
      PASSPORT_DISABLE_UPDATE_CHECK: "1",
      PASSPORT_E2E_WINDOW_MODE: "hidden",
    },
  });
  const nextPage = await app.firstWindow();
  await nextPage.waitForSelector(".home-view");
  // Older versions saved no value. An upgrade must leave suggestions off
  // for those users and preserve the preference when it already exists.
  if (!Object.hasOwn(before.settings.terminal, "inlineAutosuggestions")) {
    before.settings.terminal.inlineAutosuggestions = false;
  }
  assert.deepEqual(
    await nextPage.evaluate(
      async () => (await window.passport.call("bootstrap")).document,
    ),
    before,
  );
  if (!flowOnly) {
    assert.equal(
      await app.evaluate(({ safeStorage, app }, profileId) => {
        const require = process
          .getBuiltinModule("module")
          .createRequire(`${process.resourcesPath}/app.asar/package.json`);
        const Database = require("better-sqlite3");
        const db = new Database(`${app.getPath("userData")}/passport.sqlite`, {
          readonly: true,
        });
        try {
          const row = db
            .prepare("SELECT secret FROM credentials WHERE id=?")
            .get(profileId);
          return (
            Boolean(row?.secret) &&
            !row.secret.includes(Buffer.from("test-only-password")) &&
            JSON.parse(safeStorage.decryptString(row.secret)).password ===
              "test-only-password"
          );
        } finally {
          db.close();
        }
      }, before.hosts[0].authId),
      true,
      "Updated app must restore the actual encrypted credential row",
    );
  }
  await closeCleanly(app);
  app = undefined;
  console.log("Updated application data and normal shutdown verified");
  const packageHash = createHash("sha256");
  for await (const chunk of createReadStream(
    path.join(packageDirectory, payloadName),
  ))
    packageHash.update(chunk);
  const result = JSON.stringify(
    {
      kind: "installed-update",
      platform: process.platform,
      from: oldVersion,
      to: manifest.version,
      status: flowOnly ? "flow-verified" : "passed",
      nativeEncryption: !flowOnly,
      credentialsRestored: !flowOnly,
      packageSha256: packageHash.digest("hex"),
      osProtectionPrompts: "not-attested-by-hidden-test",
    },
    null,
    2,
  );
  await fs.writeFile(path.join(root, "result.json"), result);
  if (reportFile) await fs.writeFile(reportFile, result);
  console.log(`Installed update verified: ${root}`);
} finally {
  try {
    if (app) await closeCleanly(app);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

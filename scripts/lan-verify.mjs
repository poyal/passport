import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { expect } from "@playwright/test";
import { electron } from "./e2e-electron.mjs";
import { closeCleanly } from "../tests/fixtures/electron-exit.ts";
import { cliCoordinator } from "../tests/fixtures/cli-coordinator.ts";
import { sourceState, writeJSON } from "./release-core.mjs";
import { summarizeElectronLifecycle } from "./e2e-lifecycle.mjs";

// Run the responder on the other physical computer, then copy only its
// ready.json to the initiator. Control coordination can use SSH; application
// pairing and payloads must travel directly between distinct LAN addresses.
const argv = process.argv.slice(2);
if (argv.includes("--help")) {
  console.log(
    "node scripts/lan-verify.mjs --role responder|initiator --address <LAN IPv4> --directory release/checks/<run> [--peer <copied-ready.json>]",
  );
  process.exit(0);
}
const options = {};
while (argv.length) {
  const flag = argv.shift(),
    value = argv.shift();
  assert.ok(
    ["--role", "--address", "--directory", "--peer"].includes(flag) &&
      value &&
      !value.startsWith("--"),
    "Invalid LAN verification arguments",
  );
  assert.ok(!Object.hasOwn(options, flag.slice(2)), "Duplicate argument");
  options[flag.slice(2)] = value;
}
const { role, address } = options;
assert.ok(["responder", "initiator"].includes(role));
assert.ok(
  Object.values(os.networkInterfaces())
    .flat()
    .some((i) => i?.family === "IPv4" && i.address === address && !i.internal),
  "Select a real local LAN interface",
);
assert.ok(options.directory);
const directory = path.resolve(options.directory),
  checks = path.resolve("release/checks") + path.sep;
assert.ok(
  directory.startsWith(checks),
  "Evidence must be under release/checks",
);
await fs.mkdir(directory, { recursive: true });
await fs.writeFile(path.join(directory, "started"), new Date().toISOString(), {
  flag: "wx",
});
process.env.PASSPORT_E2E_MODE = "hidden";
process.env.PASSPORT_E2E_LIFECYCLE_LOG = path.join(
  directory,
  "lifecycle.jsonl",
);
process.env.PASSPORT_SHUTDOWN_DIAGNOSTICS = directory;
const data = await fs.mkdtemp(path.join(os.tmpdir(), "passport-lan-"));
const downloads = path.join(data, "downloads");
await fs.mkdir(downloads);
const payload = Buffer.alloc(8 * 1024 * 1024, 0x61);
Buffer.from("Passport LAN 한글 💻 e\u0301\r\n").copy(payload);
const digest = createHash("sha256").update(payload).digest("hex");
const attachment = path.join(data, "한글 첨부.txt");
await fs.writeFile(attachment, payload);
const text =
  "# Passport LAN validation\n\n한글 💻 e\u0301\n\n<script>window.__lanExecuted=true</script>";
const result = {
  status: "running",
  role,
  platform: process.platform,
  arch: process.arch,
  source: await sourceState(process.cwd()),
  address,
  fileBytes: payload.length,
  sha256: digest,
  checks: [],
};
let app;
try {
  app = await electron.launch({
    executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
    args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
    env: {
      ...process.env,
      PASSPORT_DATA_DIR: path.join(data, "app"),
      PASSPORT_DISABLE_UPDATE_CHECK: "1",
    },
  });
  assert.equal(
    await app.evaluate(({ safeStorage }) =>
      safeStorage.isEncryptionAvailable(),
    ),
    true,
    "Real OS encryption is required",
  );
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector(".home-view");
  const prepareCLI = async () => {
    const terminal = await page.evaluate(async () => {
      const boot = await window.passport.call("bootstrap", undefined);
      boot.document.settings.terminal.shell =
        boot.platform === "win32" ? "passport-bash" : "bash";
      boot.document.settings.terminal.profileIds = [];
      boot.document.settings.terminal.cliAccess = "off";
      await window.passport.call("save", boot.document);
      const target = await window.passport.call("terminal.create", undefined);
      const current = await window.passport.call("bootstrap", undefined);
      const workspace = current.document.workspaces.find(
        (w) => w.id === target.workspaceId,
      );
      await window.passport.call("session.connect", {
        id: target.paneId,
        hostId: workspace.root.hostId,
      });
      return target.paneId;
    });
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(() =>
              window.passport.call("bootstrap", undefined),
            )
          ).sessionStates.find((s) => s.id === terminal)?.environment?.status,
      )
      .toBe("ready");
    return cliCoordinator(page, terminal, data);
  };
  const call = (name, input) =>
    page.evaluate(({ name, input }) => window.passport.call(name, input), {
      name,
      input,
    });
  const snapshot = () => call("share.state");
  const wait = async (predicate, description, timeout = 180000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const state = await snapshot();
      assert.ok(!state.error, state.error);
      const found = predicate(state);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`LAN verification timed out: ${description}`);
  };
  await call("share.configure", {
    ...(await snapshot()).settings,
    enabled: true,
    discoverable: false,
    address,
    receiveDirectory: downloads,
  });
  assert.equal((await snapshot()).endpoint.address, address);
  // A terminal receives sharing access at creation. Create it after enabling
  // sharing; existing terminals intentionally keep their original permissions.
  const cli = await prepareCLI();
  await page.locator('.app-tab[aria-label="쪽지"]').click();
  let peer;
  if (role === "responder") {
    const invitation = await call("share.invite");
    await fs.writeFile(
      path.join(directory, "ready.json"),
      JSON.stringify({ ...invitation, address, platform: process.platform }),
      { mode: 0o600 },
    );
    console.log(`LAN responder ready: ${directory}`);
    const request = await wait(
      (s) => s.requests.length === 1 && s.requests[0],
      "explicit pairing request",
    );
    assert.equal((await snapshot()).peers.length, 0);
    await page
      .locator(".sharing-view")
      .getByLabel("상대 별칭", { exact: true })
      .fill("LAN 시험 상대");
    await page
      .getByRole("button", { name: "사용자 등록 승인", exact: true })
      .click();
    peer = await wait(
      (s) => s.peers.length === 1 && s.peers[0],
      "pair approval",
    );
    assert.ok(request.id);
  } else {
    assert.ok(
      options.peer,
      "Initiator needs the responder's copied ready.json",
    );
    const remote = JSON.parse(await fs.readFile(options.peer, "utf8"));
    assert.notEqual(
      remote.address,
      address,
      "Two distinct computers are required",
    );
    assert.notEqual(
      remote.platform,
      process.platform,
      "This scenario verifies Windows ↔ macOS",
    );
    await call("share.join", { key: remote.key, alias: "LAN 시험 상대" });
    peer = await wait(
      (s) => s.peers.length === 1 && s.peers[0],
      "peer approval",
    );
  }
  assert.notEqual(peer.endpoint.address, address);
  assert.ok(
    !peer.endpoint.address.startsWith("127."),
    "No loopback or SSH tunnel endpoint",
  );
  result.peerAddress = peer.endpoint.address;
  result.checks.push(
    "explicit pairing over distinct LAN endpoints with real OS encryption",
  );
  const send = async () => {
    const sent = await call("share.send", {
      to: peer.id,
      text,
      file: attachment,
    });
    // The UI hides completed transfers. Read the content-free receipt through
    // the real terminal CLI, as a user/agent would, after the active job ends.
    await wait(
      (s) => !s.transfers.some((t) => t.id === sent.id),
      "attachment delivery",
    );
    const receipt = await cli(["share", "status", sent.id]);
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(receipt.value.state, "delivered", receipt.value.error);
    result.checks.push("outgoing 8 MiB attachment acknowledged as delivered");
  };
  const receive = async () => {
    const incoming = await wait(
      (s) =>
        s.transfers.find(
          (t) => t.direction === "incoming" && t.state === "pending",
        ),
      "incoming approval",
    );
    assert.equal(
      (await snapshot()).messages.length,
      0,
      "Message content must not be available before approval",
    );
    assert.deepEqual(
      await fs.readdir(downloads),
      [],
      "Attachment must not be saved before approval",
    );
    await page.locator(".share-message-list button.pending").first().click();
    await expect(page.locator(".share-markdown")).toHaveCount(0);
    await page
      .getByRole("button", { name: "승인하고 저장", exact: true })
      .click();
    const message = await wait(
      (s) => s.messages.find((m) => m.id === incoming.id),
      "received message",
    );
    const full = await call("share.message", { id: message.id });
    assert.equal(full.markdown, text);
    assert.equal(full.attachment.bytes, payload.length);
    const saved = await fs.readFile(full.attachment.path);
    assert.equal(createHash("sha256").update(saved).digest("hex"), digest);
    await page
      .locator(".share-message-list button")
      .filter({ hasText: "Passport LAN validation" })
      .first()
      .click();
    await expect(page.locator(".share-markdown h1")).toHaveText(
      "Passport LAN validation",
    );
    await expect(
      page.locator(".share-markdown script, .share-markdown iframe"),
    ).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.__lanExecuted), undefined);
    if (process.platform === "win32") {
      const zone = await fs.readFile(
        full.attachment.path + ":Zone.Identifier",
        "utf8",
      );
      assert.match(zone, /ZoneId=3/);
    } else {
      const { execFileSync } = await import("node:child_process");
      assert.ok(
        execFileSync(
          "xattr",
          ["-p", "com.apple.quarantine", full.attachment.path],
          { encoding: "utf8" },
        ).trim(),
      );
    }
    result.checks.push(
      "approval before content/file disclosure, exact Unicode and SHA-256, inert HTML, OS download protection",
    );
    await page.screenshot({ path: path.join(directory, "received.png") });
  };
  if (role === "initiator") {
    await send();
    await receive();
  } else {
    await receive();
    await send();
  }
  if (role === "initiator") {
    const sent = await call("share.send", {
      to: peer.id,
      text: "LAN_REJECT_VALIDATION",
    });
    await wait(
      (s) => !s.transfers.some((t) => t.id === sent.id),
      "rejection propagation",
    );
    const receipt = await cli(["share", "status", sent.id]);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.value.state, "rejected");
    await call("share.peer", { id: peer.id, remove: true });
    await assert.rejects(
      call("share.send", { to: peer.id, text: "LAN_REVOKED_VALIDATION" }),
    );
    result.checks.push("remote rejection and revoked peer cannot send");
  } else {
    const incoming = await wait(
      (s) =>
        s.transfers.find(
          (t) => t.direction === "incoming" && t.state === "pending",
        ),
      "second approval request",
    );
    const before = (await snapshot()).messages.length;
    await page.locator(".share-message-list button.pending").first().click();
    await page.getByRole("button", { name: "거절", exact: true }).click();
    assert.equal((await snapshot()).messages.length, before);
    await wait(
      (s) => !s.transfers.some((t) => t.id === incoming.id),
      "local rejection",
    );
    const receipt = await cli(["share", "status", incoming.id]);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.value.state, "rejected");
    result.checks.push("rejected content stays unavailable");
    // Keep the rejection receipt available for the sender's 2-second status
    // polling before closing this disposable listener. Revocation is tested
    // on the initiator; it does not delete the other machine's address book.
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  assert.deepEqual(errors, []);
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  try {
    if (app) await closeCleanly(app);
    const events = (
      await fs.readFile(process.env.PASSPORT_E2E_LIFECYCLE_LOG, "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    result.lifecycle = summarizeElectronLifecycle(events);
    assert.equal(result.lifecycle.launches, result.lifecycle.auditedShutdowns);
    assert.equal(result.lifecycle.shown, 0);
    assert.equal(result.lifecycle.focused, 0);
  } catch (error) {
    result.status = "failed";
    result.shutdownError = String(error);
    process.exitCode = 1;
  }
  result.finishedAt = new Date().toISOString();
  await writeJSON(path.join(directory, "result.json"), result);
  await fs.rm(path.join(directory, "ready.json"), { force: true });
  await fs.rm(data, { recursive: true, force: true });
  console.log(
    `LAN verification ${result.status}: ${path.join(directory, "result.json")}`,
  );
}

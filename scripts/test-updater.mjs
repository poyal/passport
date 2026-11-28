// Real native helper/file replacement tests with a tiny process fixture.
// These do not substitute for installed Passport or Gatekeeper/DPAPI tests.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { prepareUpdatePackage } from "./update-package.mjs";

const root = path.resolve("release/checks", `updater-${randomUUID()}`);
await fs.mkdir(root, { recursive: true });
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const key = publicKey.export({ format: "pem", type: "spki" }).toString();
const privateKeyFile = path.join(root, "test-key.pem");
await fs.writeFile(
  privateKeyFile,
  privateKey.export({ format: "pem", type: "pkcs8" }),
  { mode: 0o600 },
);
const cargo = process.env.PASSPORT_CARGO || "cargo";
const rustc = process.env.PASSPORT_RUSTC || "rustc";
const suffix = process.platform === "win32" ? ".exe" : "";
const fixture = path.join(root, `fixture${suffix}`);
const results = [];
try {
  execFileSync(
    cargo,
    [
      "build",
      "--locked",
      "--manifest-path",
      "native/helper/Cargo.toml",
      "--bin",
      "passport-updater",
    ],
    {
      env: { ...process.env, PASSPORT_UPDATE_PUBLIC_KEY: key },
      stdio: "pipe",
      windowsHide: true,
    },
  );
  execFileSync(rustc, ["tests/fixtures/update-app.rs", "-o", fixture], {
    stdio: "pipe",
    windowsHide: true,
  });
  const updater = path.resolve(
    `native/helper/target/debug/passport-updater${suffix}`,
  );
  for (const scenario of [
    "apply",
    "startup-rollback",
    "bad-signature",
    "bad-package",
    "interrupted-recovery",
    "healthy-recovery",
  ]) {
    const base = path.join(root, scenario);
    const data = path.join(base, "data");
    const transaction = path.join(data, "updates", randomUUID());
    const target = path.join(base, "Passport.app");
    const source = path.join(base, "candidate.app");
    const relativeExe =
      process.platform === "win32" ? "Passport.exe" : "Contents/MacOS/Passport";
    for (const app of [target, source]) {
      await fs.mkdir(path.dirname(path.join(app, relativeExe)), {
        recursive: true,
      });
      await fs.copyFile(fixture, path.join(app, relativeExe));
      await fs.chmod(path.join(app, relativeExe), 0o755);
      if (process.platform === "darwin")
        await fs.writeFile(
          path.join(app, "Contents/Info.plist"),
          `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>io.passport.updater-fixture</string><key>CFBundleExecutable</key><string>Passport</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
        );
    }
    const markers = process.platform === "darwin" ? "Contents/Resources" : ".";
    await fs.mkdir(path.join(target, markers), { recursive: true });
    await fs.mkdir(path.join(source, markers), { recursive: true });
    if (scenario === "startup-rollback")
      await fs.writeFile(path.join(source, markers, "fail-startup"), "");
    await fs.writeFile(path.join(target, markers, "old-version"), "1.0.0");
    await fs.writeFile(path.join(source, markers, "new-version"), "1.0.1");
    // Seal after all fixture changes on macOS.
    if (process.platform === "darwin")
      execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", source], {
        stdio: "pipe",
      });
    await fs.mkdir(transaction, { recursive: true });
    await fs.writeFile(path.join(data, "passport.sqlite"), "old-database");
    if (process.platform === "win32")
      await fs.writeFile(
        path.join(target, "Uninstall Passport.exe"),
        "preserve-uninstaller",
      );
    const files = await prepareUpdatePackage({
      app: source,
      output: path.join(base, "output"),
      version: "1.0.1",
      privateKeyFile,
      publicKey: key,
      target: `${process.platform}-${process.arch}`,
    });
    for (const [i, dest] of [
      "package.zip",
      "update.json",
      "update.sig",
    ].entries())
      await fs.copyFile(
        path.join(base, "output", files[i]),
        path.join(transaction, dest),
      );
    if (scenario === "bad-signature")
      await fs.writeFile(
        path.join(transaction, "update.sig"),
        Buffer.alloc(64),
      );
    if (scenario === "bad-package")
      await fs.appendFile(path.join(transaction, "package.zip"), "tampered");
    const parent = spawn(process.execPath, ["-e", "setTimeout(()=>{},100)"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const parentPid = parent.pid;
    await once(parent, "exit");
    await fs.writeFile(
      path.join(transaction, "request.json"),
      JSON.stringify({
        target,
        data,
        current: "1.0.0",
        version: "1.0.1",
        pid: parentPid,
        token: randomUUID(),
      }),
    );
    const recovery = scenario.endsWith("recovery");
    if (recovery) {
      await fs.rename(
        target,
        path.join(base, `.passport-backup-${path.basename(transaction)}`),
      );
      await fs.cp(source, target, { recursive: true, verbatimSymlinks: true });
      if (process.platform === "win32")
        await fs.writeFile(
          path.join(target, "Uninstall Passport.exe"),
          "preserve-uninstaller",
        );
      await fs.mkdir(path.join(transaction, "databases"));
      await fs.copyFile(
        path.join(data, "passport.sqlite"),
        path.join(transaction, "databases/passport.sqlite"),
      );
      await fs.writeFile(path.join(data, "passport.sqlite"), "new-database");
      await fs.writeFile(
        path.join(transaction, "journal.jsonl"),
        '{"state":"installed"}\n',
      );
      if (scenario === "healthy-recovery") {
        const request = JSON.parse(
          await fs.readFile(path.join(transaction, "request.json")),
        );
        await fs.writeFile(path.join(transaction, "healthy"), request.token);
      }
    }
    let failed = false;
    try {
      execFileSync(updater, [transaction, ...(recovery ? ["--recover"] : [])], {
        cwd: process.platform === "win32" ? target : undefined,
        timeout: 30_000,
        stdio: "pipe",
        windowsHide: true,
      });
    } catch {
      failed = true;
    }
    assert.equal(failed, scenario.startsWith("bad-"), scenario);
    const applied = scenario === "apply" || scenario === "healthy-recovery";
    assert.equal(
      await fs.readFile(path.join(data, "passport.sqlite"), "utf8"),
      applied ? "new-database" : "old-database",
      scenario,
    );
    await fs.access(
      path.join(target, markers, applied ? "new-version" : "old-version"),
    );
    if (process.platform === "win32")
      assert.equal(
        await fs.readFile(path.join(target, "Uninstall Passport.exe"), "utf8"),
        "preserve-uninstaller",
      );
    results.push({ scenario, status: "passed" });
    console.log(`${scenario}: PASS`);
  }
  await fs.writeFile(
    path.join(root, "result.json"),
    JSON.stringify(
      { kind: "native-updater-fixtures", platform: process.platform, results },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(privateKeyFile, { force: true });
}

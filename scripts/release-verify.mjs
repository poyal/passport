import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  repository,
  schemaVersion,
  sourceState,
  assertSameSource,
  installerName,
  hashFile,
  writeJSON,
  withReleaseLock,
  parseArguments,
} from "./release-core.mjs";
import { runCommand } from "./release-process.mjs";
import { beginWindowsPtyAudit } from "./windows-pty-audit.mjs";
import { summarizeElectronLifecycle } from "./e2e-lifecycle.mjs";
import {
  loadGuiPolicy,
  requestedGuiFeatures,
  validateGuiReport,
} from "./release-gui-policy.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const options = parseArguments(process.argv.slice(2));
if (options.help) {
  console.log(
    "npm run release:verify -- --preview [--desktop]\nnpm run release:verify -- --desktop\nPreview defaults to hidden GUI. --desktop also runs native focus/clipboard checks and explicitly permits desktop interruption. Formal verification requires --desktop; preview receipts cannot be published.",
  );
} else {
  assert.ok(
    !options.execute &&
      !options.manifests.length &&
      !options["replace-windows-icon"],
    "Verification accepts --preview, --desktop, or --help",
  );
  await withReleaseLock(root, verify).catch((error) => {
    console.error(`Local release verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}

async function verify() {
  process.chdir(root);
  assert.ok(
    options.preview || options.desktop,
    "Formal release verification includes native focus/clipboard checks. Use --desktop on a dedicated desktop, or --preview for hidden checks while working.",
  );
  const source = await sourceState(root);
  assert.ok(
    !source.dirty || options.preview,
    "Commit changes first, or use --preview for a non-publishable rehearsal.",
  );
  assert.ok(
    Number(process.versions.node.split(".")[0]) >= 24,
    "Node.js 24 or newer is required",
  );
  const target = `${process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : "unsupported"}-${process.arch}`;
  const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
  const name = installerName(pkg.version, target);
  await fs.access(`docs/releases/v${pkg.version}.md`);
  const cargo = process.env.PASSPORT_CARGO || "cargo";
  let rustVersion;
  try {
    rustVersion = execFileSync(cargo, ["--version"], {
      encoding: "utf8",
    }).trim();
  } catch {
    throw new Error(
      "Rust cargo is required. Install the Rust toolchain or set PASSPORT_CARGO (and its CARGO_HOME/RUSTUP_HOME if isolated). See docs/local-release-guide.md.",
    );
  }
  const npmCLI = process.env.npm_execpath;
  assert.ok(npmCLI, "Run this command using npm run release:verify");
  const id = `${new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(
      /\.\d+Z/,
      "Z",
    )}-${source.commit.slice(0, 7)}${source.dirty ? "-dirty" : ""}-${target}-local-release`;
  const build = path.join(root, "release/builds", id);
  const checks = path.join(root, "release/checks", id);
  await fs.mkdir(build, { recursive: true });
  await fs.mkdir(checks, { recursive: true });
  const relative = (file) =>
    path.relative(root, file).split(path.sep).join("/");
  const manifest = path.join(checks, "verification.json");
  const record = {
    schemaVersion,
    repository,
    version: pkg.version,
    target,
    source,
    preview: options.preview,
    desktopChecks: options.desktop,
    guiOptionalFeatures: requestedGuiFeatures(),
    status: "running",
    createdAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      os: os.release(),
      node: process.version,
      npm: execFileSync(process.execPath, [npmCLI, "--version"], {
        encoding: "utf8",
      }).trim(),
      cargo: rustVersion,
      electron: pkg.devDependencies.electron,
    },
    checks: [],
    evidence: [],
    limitations: [
      ...(!options.desktop
        ? [
            "Native desktop focus/clipboard checks are excluded from this background preview; it cannot authorize publication.",
          ]
        : []),
      "Physical IME, OS notifications, real AI services, upgrade installation, and optional Docker/long stress tests are separate checks.",
      "Windows installer UI/scope and extracted payload are checked; installing/uninstalling into a user account is a separate check.",
    ],
  };
  const save = async () => {
    await writeJSON(manifest, record);
    for (const directory of [build, checks])
      await writeJSON(path.join(directory, "artifact.json"), {
        createdAt: record.createdAt,
        purpose: "local-release-verification",
        sourceCommit: source.commit,
        dirty: source.dirty,
        platform: target,
        source: "local",
        status: record.status,
        verification: relative(manifest),
        artifact: record.artifact,
        checks: record.checks.map(({ name, status }) => ({ name, status })),
        guiLifecycle: record.guiLifecycle,
      });
  };
  const env = {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    PASSPORT_DISABLE_UPDATE_CHECK: "1",
    PASSPORT_TARGET_ARCH: process.arch,
    PASSPORT_TARGET_PLATFORM: process.platform,
    PASSPORT_SHUTDOWN_DIAGNOSTICS: checks,
    PASSPORT_E2E_MODE: "hidden",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PASSPORT_E2E_EXECUTABLE;
  const step = async (name, action) => {
    const entry = {
      name,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    record.checks.push(entry);
    await save();
    console.log(`\n[local release] ${name}`);
    try {
      await action();
      entry.status = "passed";
    } catch (error) {
      entry.status = "failed";
      entry.error = error.message;
      throw error;
    } finally {
      entry.finishedAt = new Date().toISOString();
      await save();
    }
  };
  const command = async (label, executable, args, extra = {}) => {
    const log = path.join(checks, `${label}.log`);
    await runCommand(executable, args, { cwd: root, env, log, ...extra });
    record.evidence.push({ path: relative(log), sha256: await hashFile(log) });
  };
  const node = (label, script, args = [], extra) =>
    command(label, process.execPath, [script, ...args], extra);
  const npm = (label, args, extra) => node(label, npmCLI, args, extra);
  const gui = async (label, executable, mode = "hidden") => {
    const audit = await beginWindowsPtyAudit(root, executable);
    const lifecycleFile = path.join(checks, `${label}-lifecycle.jsonl`);
    const report = path.join(checks, `${label}.json`);
    const guiEnv = {
      ...env,
      PASSPORT_E2E_EXECUTABLE: executable || "",
      PASSPORT_E2E_MODE: mode,
      PASSPORT_E2E_LIFECYCLE_LOG: lifecycleFile,
    };
    const discovery = path.join(checks, `${label}-discovery.json`);
    await node(
      `${label}-discovery`,
      "node_modules/@playwright/test/cli.js",
      ["test", "--list"],
      {
        env: { ...guiEnv, PASSPORT_TEST_REPORT: discovery },
      },
    );
    const policy = loadGuiPolicy(root);
    validateGuiReport(
      JSON.parse(await fs.readFile(discovery, "utf8")),
      {
        platform: process.platform,
        mode,
        optional: record.guiOptionalFeatures,
      },
      policy,
      true,
    );
    record.evidence.push({
      path: relative(discovery),
      sha256: await hashFile(discovery),
    });
    await node(
      label,
      "node_modules/@playwright/test/cli.js",
      ["test", "--max-failures=1", "--output", path.join(checks, label)],
      {
        timeout: 12 * 60 * 1000,
        env: {
          ...guiEnv,
          PASSPORT_TEST_REPORT: report,
          PASSPORT_E2E_MODE: mode,
        },
      },
    );
    const events = (await fs.readFile(lifecycleFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const lifecycle = summarizeElectronLifecycle(events);
    assert.ok(lifecycle.launches > 0, "GUI must launch the real app");
    assert.equal(
      lifecycle.exits,
      lifecycle.launches,
      "Every GUI app must exit",
    );
    if (mode !== "desktop") {
      assert.equal(
        lifecycle.auditedShutdowns,
        lifecycle.launches,
        "Every background app must have a shutdown audit",
      );
      assert.equal(
        lifecycle.focused,
        0,
        "Background GUI must not focus native windows",
      );
      if (mode === "hidden")
        assert.equal(
          lifecycle.shown,
          0,
          "Hidden GUI must not show native windows",
        );
    }
    (record.guiLifecycle ??= {})[label] = lifecycle;
    record.evidence.push({
      path: relative(lifecycleFile),
      sha256: await hashFile(lifecycleFile),
    });
    if (audit) {
      const nativeProcesses = await audit();
      const auditFile = path.join(checks, `${label}-native-processes.json`);
      await writeJSON(auditFile, nativeProcesses);
      record.evidence.push({
        path: relative(auditFile),
        sha256: await hashFile(auditFile),
      });
      assert.ok(
        nativeProcesses.passed,
        "Windows PTY processes survived the GUI suite",
      );
    }
    const result = JSON.parse(await fs.readFile(report, "utf8"));
    const coverage = validateGuiReport(
      result,
      {
        platform: process.platform,
        mode,
        optional: record.guiOptionalFeatures,
      },
      policy,
    );
    record.checks.at(-1).tests = result.stats;
    record.checks.at(-1).mode = mode;
    record.checks.at(-1).report = relative(report);
    record.checks.at(-1).coverage = coverage;
    record.evidence.push({
      path: relative(report),
      sha256: await hashFile(report),
    });
  };
  let mount;
  try {
    await save();
    // A release always starts from locked dependencies. Iterative development
    // uses release:check / focused tests; it does not repeat this full pipeline.
    await step("dependencies", () =>
      npm("dependencies", ["ci"], { timeout: 20 * 60 * 1000 }),
    );
    await step("ftp-fixtures", async () => {
      let python = process.env.FTP_TEST_PYTHON;
      if (!python) {
        const venv = path.join(checks, "python");
        await command(
          "python-venv",
          process.platform === "win32" ? "python" : "python3",
          ["-m", "venv", venv],
        );
        python = path.join(
          venv,
          process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
        );
        await command("python-requirements", python, [
          "-m",
          "pip",
          "install",
          "-r",
          "tests/fixtures/requirements.txt",
        ]);
      }
      await command("ftp-fixtures", python, [
        "-c",
        "import pyftpdlib, OpenSSL; print('FTP and FTPS fixtures ready')",
      ]);
      env.FTP_TEST_PYTHON = python;
      await command("openssl", "openssl", ["version"]);
    });
    if (process.platform === "win32") {
      await step("windows-tools", async () => {
        await fs.access(
          path.join(
            process.env.ProgramFiles || "C:\\Program Files",
            "PowerShell/7/pwsh.exe",
          ),
        );
        await command("powershell7", "pwsh", [
          "-NoProfile",
          "-Command",
          "$PSVersionTable.PSVersion.ToString()",
        ]);
        await node("runtime", "scripts/prepare-runtime.mjs", [process.arch]);
      });
    }
    await step("build", () =>
      npm("build", ["run", "build"], { timeout: 15 * 60 * 1000 }),
    );
    await step("unit", () => npm("unit", ["run", "check"]));
    await step("release-tests", () =>
      npm("release-tests", ["run", "test:release"]),
    );
    await step("source-gui", () => gui("source-gui"));
    if (options.desktop)
      await step("source-desktop", () =>
        gui("source-desktop", undefined, "desktop"),
      );
    await step("package", () =>
      node(
        "package",
        "node_modules/electron-builder/cli.js",
        [
          process.platform === "darwin" ? "--mac" : "--win",
          process.platform === "darwin" ? "dmg" : "nsis",
          `--${process.arch}`,
          "--publish",
          "never",
          // Package the exact locked Electron installed by npm ci. Avoid a
          // second download of the same runtime during local verification.
          "--config.electronDist=node_modules/electron/dist",
          `--config.directories.output=${build}`,
        ],
        { timeout: 15 * 60 * 1000 },
      ),
    );
    const installer = path.join(build, name);
    const installerHash = await hashFile(installer);
    let executable;
    await step("installer", async () => {
      if (process.platform === "darwin") {
        await command("dmg-verify", "hdiutil", ["verify", installer]);
        mount = path.join(checks, "mounted-dmg");
        await fs.mkdir(mount);
        await command("dmg-mount", "hdiutil", [
          "attach",
          "-readonly",
          "-nobrowse",
          "-mountpoint",
          mount,
          installer,
        ]);
        const app = path.join(mount, "Passport.app");
        executable = path.join(app, "Contents/MacOS/Passport");
        await command("codesign", "codesign", [
          "--verify",
          "--deep",
          "--strict",
          app,
        ]);
      } else {
        await command("installer-scope", "pwsh", [
          "-NoProfile",
          "-File",
          "scripts/windows-installer-smoke.ps1",
          "-InstallerPath",
          installer,
        ]);
        const { getPath7za } =
          await import("app-builder-lib/out/toolsets/7zip.js");
        const unzip = await getPath7za();
        const archive = path.join(checks, "nsis");
        await command("nsis-extract", unzip, [
          "x",
          "-y",
          `-o${archive}`,
          installer,
        ]);
        // The minimal 7za tool extracts the embedded app archive directly.
        // A full NSIS-capable 7-Zip may expose the separate payload archive.
        const directExecutable = path.join(archive, "Passport.exe");
        if (
          await fs.access(directExecutable).then(
            () => true,
            () => false,
          )
        ) {
          executable = directExecutable;
        } else {
          const payloads = (
            await fs.readdir(path.join(archive, "$PLUGINSDIR"))
          ).filter((file) => /^app-.*\.7z$/.test(file));
          assert.equal(
            payloads.length,
            1,
            "Expected exactly one installer payload",
          );
          const payload = path.join(checks, "installed-payload");
          await command("payload-extract", unzip, [
            "x",
            "-y",
            `-o${payload}`,
            path.join(archive, "$PLUGINSDIR", payloads[0]),
          ]);
          executable = path.join(payload, "Passport.exe");
        }
      }
      await fs.access(executable);
    });
    await step("packaged-smoke", () =>
      node("packaged-smoke", "scripts/packaged-smoke.mjs", [executable], {
        timeout: 90000,
      }),
    );
    await step("packaged-gui", () => gui("packaged-gui", executable));
    if (options.desktop)
      await step("packaged-desktop", () =>
        gui("packaged-desktop", executable, "desktop"),
      );
    assert.equal(
      await hashFile(installer),
      installerHash,
      "Installer changed during verification",
    );
    assertSameSource(source, await sourceState(root));
    record.artifact = {
      name,
      path: relative(installer),
      bytes: (await fs.stat(installer)).size,
      sha256: installerHash,
    };
    record.status = options.preview ? "preview-verified" : "verified";
    record.finishedAt = new Date().toISOString();
    if (process.platform === "darwin") {
      const link = path.join(root, "release/builds/Passport.app");
      const current = await fs.lstat(link).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      assert.ok(
        !current || current.isSymbolicLink(),
        "Refusing to replace a real Passport.app directory",
      );
      const pending = `${link}.next-${process.pid}`;
      await fs.symlink(
        path.relative(
          path.dirname(link),
          path.join(build, "mac-arm64/Passport.app"),
        ),
        pending,
      );
      await fs.rename(pending, link);
    }
    await save();
    console.log(
      `\nVerification: ${relative(manifest)}\nStatus: ${record.status}\nInstaller SHA-256: ${installerHash}`,
    );
  } catch (error) {
    record.status = "failed";
    record.finishedAt = new Date().toISOString();
    record.error = error.message;
    await save();
    throw error;
  } finally {
    if (mount)
      await runCommand("hdiutil", ["detach", mount], {
        cwd: root,
        timeout: 30000,
      }).catch((error) => {
        console.error(
          `DMG detach needs attention: ${error.message}. Mount: ${mount}`,
        );
      });
  }
}

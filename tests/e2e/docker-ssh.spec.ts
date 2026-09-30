import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hostSchema } from "../../src/shared/model";
import type { Calls, TransferJob } from "../../src/shared/model";
import { closeCleanly } from "../fixtures/electron-exit";

test("real Docker SSH and SFTP through the desktop application", async ({}, info) => {
  test.skip(
    !process.env.PASSPORT_DOCKER_MANIFEST,
    "Run with npm run test:ssh:docker.",
  );
  test.setTimeout(300000);
  const config = JSON.parse(
    await fs.readFile(process.env.PASSPORT_DOCKER_MANIFEST!, "utf8"),
  ) as {
    hosts: { name: string; port: number }[];
    password: string;
    privateKey: string;
    passphrase: string;
    dockerPlatform: string;
  };
  const results: unknown[] = [];
  const hash = async (file: string) => {
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    return digest.digest("hex");
  };
  for (const [index, entry] of config.hosts.entries()) {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "passport-docker-ui-"),
    );
    const app = await electron.launch({
      executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
      args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
      env: {
        ...process.env,
        PASSPORT_DATA_DIR: path.join(directory, "data"),
        PASSPORT_DISABLE_UPDATE_CHECK: "1",
      },
    });
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({
          response: 1,
          checkboxChecked: false,
        });
      });
      await expect(page.locator(".hosts-view")).toBeVisible();
      const hosts = config.hosts.map((server) =>
        hostSchema.parse({
          id: randomUUID(),
          name: server.name,
          address: "127.0.0.1",
          port: server.port,
          username: "passport",
        }),
      );
      const host = hosts[index],
        other = hosts[(index + 1) % hosts.length];
      const password = {
        type: "password" as const,
        password: config.password,
        privateKey: "",
        passphrase: "",
      };
      const key = {
        type: "key" as const,
        password: "",
        privateKey: config.privateKey,
        passphrase: config.passphrase,
      };
      await page.evaluate(
        async ({ hosts, host, password }) => {
          await window.passport.call("auth.save", {
            id: host.id,
            name: host.name,
            username: host.username,
            secret: password,
          });
          const { document } = await window.passport.call(
            "bootstrap",
            undefined,
          );
          document.hosts = hosts.map((h) =>
            h.id === host.id ? { ...h, authId: host.id } : h,
          );
          await window.passport.call("save", document);
        },
        { hosts, host, password },
      );
      await page
        .locator(".host-row")
        .filter({ hasText: entry.name })
        .filter({ hasText: String(entry.port) })
        .first()
        .click();
      await page.getByRole("button", { name: "SSH 연결", exact: true }).click();
      await expect(
        page.locator(".view:not([hidden]) .pill").first(),
      ).toHaveText("1 / 1 연결");
      const paneId = (await page
        .locator(".view:not([hidden]) .terminal-pane")
        .getAttribute("data-pane-id"))!;
      const terminal = page.locator(
        ".view:not([hidden]) .xterm-helper-textarea",
      );
      await terminal.focus();
      await page.keyboard.insertText("printf 'DOCKER_%s\\n' '한글 SSH 정상'");
      await page.keyboard.press("Enter");
      await expect(
        page.locator(".view:not([hidden]) .xterm-rows"),
      ).toContainText("DOCKER_한글 SSH 정상");
      await page.evaluate(
        async ({ paneId, hostId, key }) => {
          await window.passport.call("session.close", { id: paneId });
          await window.passport.call("session.connect", {
            id: paneId,
            hostId,
            secret: key,
          });
          await window.passport.call("session.input", {
            id: paneId,
            data: "printf 'KEY_%s\\n' 'AUTH_OK'\r",
          });
        },
        { paneId, hostId: host.id, key },
      );
      await expect(
        page.locator(".view:not([hidden]) .xterm-rows"),
      ).toContainText("KEY_AUTH_OK");
      await page.getByRole("button", { name: "호스트", exact: true }).click();
      await page
        .getByRole("button", { name: "파일 오른쪽", exact: true })
        .click();
      await expect(
        page
          .getByRole("region", { name: "오른쪽 파일 패널" })
          .locator(".panel-status"),
      ).toContainText("SFTP");
      const endpoints = await page.evaluate(() =>
        window.passport.call("files.connections", undefined),
      );
      const remote = endpoints.find((endpoint) => endpoint.hostId === host.id)!;
      const local = endpoints.find(
        (endpoint) => endpoint.protocol === "local",
      )!;
      expect(remote?.protocol).toBe("sftp");
      const folderName = "passport-ui-" + randomUUID();
      const folder = path.posix.join(remote.initialPath, folderName);
      await page.evaluate(
        async ({ remote, folderName }) => {
          await window.passport.call("files.action", {
            id: remote.id,
            action: "mkdir",
            paths: [remote.initialPath],
            name: folderName,
          });
        },
        { remote, folderName },
      );
      const input = path.join(directory, "input"),
        output = path.join(directory, "output");
      await fs.mkdir(input);
      await fs.mkdir(output);
      const name = "한글 공백 파일.bin",
        source = path.join(input, name);
      const bytes = randomBytes(2 * 1024 ** 2);
      await fs.writeFile(source, bytes);
      const expected = await hash(source);
      await page.getByLabel("왼쪽 경로", { exact: true }).fill(input);
      await page.getByLabel("왼쪽 경로", { exact: true }).press("Enter");
      await page.getByLabel("오른쪽 경로", { exact: true }).fill(folder);
      await page.getByLabel("오른쪽 경로", { exact: true }).press("Enter");
      const left = page.getByRole("region", { name: "왼쪽 파일 패널" });
      await left.getByText(name, { exact: true }).click({ button: "right" });
      await page
        .getByRole("menuitem", { name: "오른쪽 폴더로 복사", exact: true })
        .click();
      await expect(page.locator(".transfer-row.completed")).toHaveCount(1, {
        timeout: 30000,
      });
      await expect(
        page
          .getByRole("region", { name: "오른쪽 파일 패널" })
          .getByText(name, { exact: true }),
      ).toBeVisible();
      // Observe the real transfer events before adding a job, including immediate completion.
      const transfer = async (
        input: Calls["transfer.add"]["input"],
        cancel = false,
      ) => {
        const job = await page.evaluate(
          async ({ input, cancel }) =>
            new Promise<TransferJob>((resolve, reject) => {
              const jobs = new Map<string, TransferJob>();
              let id: string | undefined;
              let cancelSent = false;
              const timeout = setTimeout(() => {
                off();
                reject(new Error("Docker SFTP transfer timed out"));
              }, 60000);
              const finish = (job: TransferJob) => {
                if (
                  cancel &&
                  job.state === "running" &&
                  job.bytes > 0 &&
                  !cancelSent
                ) {
                  cancelSent = true;
                  void window.passport
                    .call("transfer.cancel", { id: job.id })
                    .catch(reject);
                }
                if (["queued", "running"].includes(job.state)) return;
                off();
                clearTimeout(timeout);
                resolve(job);
              };
              const off = window.passport.onEvent((event) => {
                if (event.kind === "transfer") {
                  jobs.set(event.job.id, event.job);
                  if (event.job.id === id) finish(event.job);
                }
              });
              void window.passport.call("transfer.add", input).then(
                (job) => {
                  id = job.id;
                  finish(jobs.get(id) ?? job);
                },
                (error) => {
                  off();
                  clearTimeout(timeout);
                  reject(error);
                },
              );
            }),
          { input, cancel },
        );
        if (!cancel) expect(job.error).toBeUndefined();
        expect(job.state).toBe(cancel ? "cancelled" : "completed");
        return job;
      };
      const remoteFile = path.posix.join(folder, name);
      await transfer({
        source: remote.id,
        destination: local.id,
        paths: [remoteFile],
        target: output,
        conflict: "skip",
      });
      expect(await hash(path.join(output, name))).toBe(expected);
      const skipped = await transfer({
        source: local.id,
        destination: remote.id,
        paths: [source],
        target: folder,
        conflict: "skip",
      });
      expect(skipped.skipped).toBe(1);
      await transfer({
        source: local.id,
        destination: remote.id,
        paths: [source],
        target: folder,
        conflict: "rename",
      });
      const renamed = path.posix.join(folder, name + " (1)");
      await page.evaluate(
        async ({ id, renamed }) => {
          await window.passport.call("files.action", {
            id,
            action: "chmod",
            paths: [renamed],
            mode: 0o640,
          });
          await window.passport.call("files.action", {
            id,
            action: "rename",
            paths: [renamed],
            name: "이름 변경.bin",
          });
        },
        { id: remote.id, renamed },
      );
      const listed = await page.evaluate(
        ({ id, path }) => window.passport.call("files.list", { id, path }),
        { id: remote.id, path: folder },
      );
      expect(
        listed.entries.find((file) => file.name === "이름 변경.bin")!.mode! &
          0o777,
      ).toBe(0o640);
      await transfer({
        source: local.id,
        destination: remote.id,
        paths: [source],
        target: folder,
        conflict: "overwrite",
      });
      const second = await page.evaluate(
        ({ hostId, key }) =>
          window.passport.call("files.connect", { hostId, secret: key }),
        { hostId: other.id, key },
      );
      await page.evaluate(
        ({ id, path, name }) =>
          window.passport.call("files.action", {
            id,
            action: "mkdir",
            paths: [path],
            name,
          }),
        { id: second.id, path: second.initialPath, name: folderName },
      );
      const secondFolder = path.posix.join(second.initialPath, folderName);
      await transfer({
        source: remote.id,
        destination: second.id,
        paths: [remoteFile],
        target: secondFolder,
        conflict: "skip",
      });
      await transfer({
        source: second.id,
        destination: local.id,
        paths: [path.posix.join(secondFolder, name)],
        target: output,
        conflict: "overwrite",
      });
      expect(await hash(path.join(output, name))).toBe(expected);
      const nested = path.join(input, "한글 폴더");
      await fs.mkdir(path.join(nested, "하위 폴더"), { recursive: true });
      await fs.writeFile(path.join(nested, "하위 폴더", "빈 파일.txt"), "");
      await fs.writeFile(path.join(nested, "한글.txt"), "폴더 전송 검증\n");
      await transfer({
        source: local.id,
        destination: remote.id,
        paths: [nested],
        target: folder,
        conflict: "skip",
      });
      await transfer({
        source: remote.id,
        destination: local.id,
        paths: [path.posix.join(folder, "한글 폴더")],
        target: output,
        conflict: "skip",
      });
      expect(
        await fs.readFile(path.join(output, "한글 폴더", "한글.txt"), "utf8"),
      ).toBe("폴더 전송 검증\n");
      expect(
        (
          await fs.stat(
            path.join(output, "한글 폴더", "하위 폴더", "빈 파일.txt"),
          )
        ).size,
      ).toBe(0);
      let largeRoundtripBytes = 0;
      if (entry.name === "ubuntu") {
        const large = path.join(input, "128MiB.bin");
        const handle = await fs.open(large, "w");
        try {
          for (let n = 0; n < 64; n++) await handle.write(bytes);
        } finally {
          await handle.close();
        }
        const upload = {
          source: local.id,
          destination: remote.id,
          paths: [large],
          target: folder,
          conflict: "skip" as const,
        };
        const cancelled = await transfer(upload, true);
        expect(cancelled.bytes).toBeGreaterThan(0);
        const afterCancel = await page.evaluate(
          ({ id, path }) => window.passport.call("files.list", { id, path }),
          { id: remote.id, path: folder },
        );
        expect(
          afterCancel.entries.some(
            (file) =>
              file.name.startsWith(".passport-") || file.name === "128MiB.bin",
          ),
        ).toBe(false);
        await transfer(upload);
        await transfer({
          source: remote.id,
          destination: local.id,
          paths: [path.posix.join(folder, "128MiB.bin")],
          target: output,
          conflict: "skip",
        });
        expect(await hash(path.join(output, "128MiB.bin"))).toBe(
          await hash(large),
        );
        largeRoundtripBytes = 128 * 1024 ** 2;
      }
      await page.evaluate(
        async ({ a, folder, b, secondFolder }) => {
          await window.passport.call("files.action", {
            id: a,
            action: "delete",
            paths: [folder],
          });
          await window.passport.call("files.action", {
            id: b,
            action: "delete",
            paths: [secondFolder],
          });
        },
        { a: remote.id, folder, b: second.id, secondFolder },
      );
      expect(errors).toEqual([]);
      await expect(page.locator(".transfer-row.error")).toHaveCount(0);
      await page.screenshot({
        path: info.outputPath(entry.name + "-sftp.png"),
      });
      results.push({
        server: entry.name,
        peer: other.name,
        status: "passed",
        passwordTerminal: true,
        encryptedKeyTerminal: true,
        sftpBytes: bytes.length,
        roundtripSHA256: expected,
        crossServerRoundtrip: true,
        recursiveUTF8AndEmptyFiles: true,
        conflicts: ["skip", "rename", "overwrite"],
        chmod: "0640",
        remoteRenameAndDelete: true,
        largeRoundtripBytes,
        cancelAndCleanup: entry.name === "ubuntu",
      });
      console.log(
        `Desktop Docker SSH/SFTP passed: ${entry.name} -> ${other.name}`,
      );
    } finally {
      try {
        await closeCleanly(app);
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  }
  const resultsPath =
    process.env.PASSPORT_DOCKER_GUI_RESULTS ||
    info.outputPath("docker-desktop.json");
  await fs.mkdir(path.dirname(resultsPath), { recursive: true });
  await fs.writeFile(
    resultsPath,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        clientPlatform: process.platform,
        clientArch: process.arch,
        executable: process.env.PASSPORT_E2E_EXECUTABLE || "source",
        dockerPlatform: config.dockerPlatform,
        results,
      },
      null,
      2,
    ),
  );
});

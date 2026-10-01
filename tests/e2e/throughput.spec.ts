import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { hostSchema } from "../../src/shared/model";
import { sshFixture } from "../fixtures/ssh-server";
import { closeCleanly } from "../fixtures/electron-exit";

// The SSH server respects stream backpressure; the full payload is never allocated in memory.
test("large terminal text remains interactive and bounded through 1 GiB", async ({}, info) => {
  test.skip(
    process.env.PASSPORT_TEXT_BENCH !== "1",
    "Run explicitly with npm run test:terminal:large.",
  );
  test.setTimeout(720000);
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-text-bench-"),
  );
  const server = await sshFixture(directory);
  const app = await electron.launch({
    executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
    args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
    env: { ...process.env, PASSPORT_DATA_DIR: path.join(directory, "data") },
  });
  const results: Record<string, unknown>[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "호스트", exact: true }).click();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.locator(".hosts-view")).toBeVisible();
    await app.evaluate(({ dialog, BrowserWindow }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
      BrowserWindow.getAllWindows()[0].setSize(1440, 900);
    });
    const host = hostSchema.parse({
      id: randomUUID(),
      name: "대용량 텍스트 검증",
      address: "127.0.0.1",
      port: server.port,
      username: "tester",
    });
    const id = randomUUID(),
      workspaceId = randomUUID();
    await page.evaluate(
      async ({ host, id, workspaceId }) => {
        const { document } = await window.passport.call("bootstrap", undefined);
        document.hosts = [host];
        document.workspaces = [
          {
            id: workspaceId,
            name: "대용량 텍스트",
            root: { kind: "pane", id, hostId: host.id },
          },
        ];
        document.settings.appearance = {
          ...document.settings.appearance,
          theme: "mocha",
          highlight: "log",
          highlightAddresses: true,
        };
        document.settings.logLimitMiB = 64;
        await window.passport.call("save", document);
      },
      { host, id, workspaceId },
    );
    await page.locator(".workspace-tab>button").first().click();
    await page.evaluate(
      async ({ id, hostId }) =>
        window.passport.call("session.connect", {
          id,
          hostId,
          secret: {
            type: "password",
            password: "test-only-password",
            privateKey: "",
            passphrase: "",
          },
        }),
      { id, hostId: host.id },
    );
    await expect.poll(() => server.shells.length).toBe(1);
    await expect(page.locator(".view:not([hidden]) .pill").first()).toHaveText(
      "1 / 1 연결",
    );
    await page.evaluate((id) => {
      const state = ((window as any).__textBench = {
        bytes: 0,
        tail: "",
        frames: [] as number[],
        off: () => {},
        frame: 0,
        last: performance.now(),
      });
      state.off = window.passport.onEvent((e) => {
        if (e.kind === "output" && e.id === id) {
          state.bytes += e.bytes;
          state.tail = (state.tail + e.data).slice(-4096);
        }
      });
      const tick = (now: number) => {
        state.frames.push(now - state.last);
        state.last = now;
        state.frame = requestAnimationFrame(tick);
      };
      state.frame = requestAnimationFrame(tick);
    }, id);
    const { version, platform, arch } = await app.evaluate(({ app }) => ({
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
    }));
    const line = Buffer.from(
      "2026-09-30 INFO 한글 대용량 출력 192.0.2.10 https://example.test \x1b[32mOK\x1b[0m 0123456789abcdefghijklmnopqrstuvwxyz\r\n",
    );
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    for (let p = 0; p + line.length <= chunk.length - 2; p += line.length)
      line.copy(chunk, p);
    chunk.write("\r\n", chunk.length - 2);
    const p95 = (values: number[]) =>
      values.length
        ? [...values].sort((a, b) => a - b)[
            Math.min(values.length - 1, Math.floor(values.length * 0.95))
          ]
        : 0;
    const memory: number[] = [];
    let sampling = false;
    timer = setInterval(() => {
      if (sampling) return;
      sampling = true;
      void app
        .evaluate(({ app }) =>
          app
            .getAppMetrics()
            .reduce((sum, process) => sum + process.memory.workingSetSize, 0),
        )
        .then((value) => memory.push(value / 1024))
        .finally(() => {
          sampling = false;
        });
    }, 500);
    const stages = [
      { MiB: 16, longLines: false },
      { MiB: 64, longLines: false },
      { MiB: 256, longLines: false },
      { MiB: 1024, longLines: false },
      { MiB: 8, longLines: true },
    ];
    for (const [stage, config] of stages.entries()) {
      const data = config.longLines
        ? Buffer.from("L".repeat(64 * 1024 - 2) + "\r\n")
        : chunk;
      const bytes = config.MiB * 1024 ** 2;
      const initial = await page.evaluate(() => {
        const state = (window as any).__textBench;
        state.frames = [];
        return state.bytes as number;
      });
      const sampleStart = memory.length;
      let sent = 0,
        done = false;
      const started = performance.now();
      const endMarker = `END_TEXT_STAGE_${stage}`;
      let writerFailure: unknown;
      const writer = (async () => {
        while (sent < bytes) {
          const writable = server.shells[0].write(data);
          sent += data.length;
          if (!writable) await once(server.shells[0], "drain");
        }
        server.shells[0].write(`\r\n${endMarker}\r\n`);
        await expect
          .poll(() => page.locator(".xterm-rows").innerText(), {
            timeout: 360000,
            intervals: [100],
          })
          .toContain(endMarker);
        done = true;
      })().catch((error) => {
        writerFailure = error;
        done = true;
      });
      const latency: number[] = [];
      let sample = 0,
        lastProgress = 0;
      while (!done) {
        const delay = await page.evaluate(
          async ({ id, marker }) =>
            new Promise<number>((resolve, reject) => {
              const start = performance.now();
              let tail = "";
              const timeout = setTimeout(() => {
                off();
                reject(new Error("input response exceeded 5 seconds"));
              }, 5000);
              const off = window.passport.onEvent((e) => {
                if (e.kind !== "output" || e.id !== id) return;
                // An input echo can precede a large output chunk. Inspect it
                // before trimming so a valid response is never discarded.
                tail += e.data;
                if (tail.includes(marker)) {
                  off();
                  clearTimeout(timeout);
                  resolve(performance.now() - start);
                }
                tail = tail.slice(-4096);
              });
              void window.passport
                .call("session.input", { id, data: `\r\n${marker}\r\n` })
                .catch((error) => {
                  off();
                  clearTimeout(timeout);
                  reject(error);
                });
            }),
          { id, marker: `INPUT_STAGE_${stage}_${sample++}` },
        );
        latency.push(delay);
        if (performance.now() - lastProgress > 15000) {
          console.log(
            `Text ${config.MiB} MiB${config.longLines ? " long lines" : ""}: queued ${Math.round(sent / 1024 ** 2)} MiB`,
          );
          lastProgress = performance.now();
        }
        if (memory.at(-1)! > 3072)
          throw new Error("terminal working set exceeded 3 GiB");
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      await writer;
      if (writerFailure) throw writerFailure;
      const elapsed = performance.now() - started;
      const snapshot = await page.evaluate(() => ({
        bytes: (window as any).__textBench.bytes as number,
        frames: (window as any).__textBench.frames as number[],
      }));
      const received = snapshot.bytes - initial;
      expect(received).toBeGreaterThanOrEqual(bytes);
      expect(received - bytes).toBeLessThan(16384);
      expect(errors).toEqual([]);
      await expect(
        page.locator(".view:not([hidden]) .pill").first(),
      ).toHaveText("1 / 1 연결");
      const row = {
        inputMiB: config.MiB,
        shape: config.longLines
          ? "64 KiB ASCII lines"
          : "UTF-8 Korean, ANSI colors, IP/URL and log lines",
        sentBytes: bytes,
        observedBytes: received,
        durationMs: Math.round(elapsed),
        throughputMiBps: +(config.MiB / (elapsed / 1000)).toFixed(2),
        inputSamples: latency.length,
        inputLoopbackP95Ms: +p95(latency).toFixed(1),
        inputLoopbackMaxMs: +Math.max(...latency).toFixed(1),
        frameP95Ms: +p95(snapshot.frames).toFixed(1),
        frameMaxMs: +Math.max(...snapshot.frames).toFixed(1),
        peakWorkingSetMiB: Math.round(Math.max(...memory.slice(sampleStart))),
        lastWorkingSetMiB: Math.round(memory.at(-1)!),
        tailRendered: true,
        connected: true,
      };
      results.push(row);
      console.log(JSON.stringify(row));
      await page.screenshot({
        path: info.outputPath(
          `text-${config.MiB}-${config.longLines ? "long-lines" : "logs"}.png`,
        ),
      });
      await fs.writeFile(
        info.outputPath("terminal-large-text.json"),
        JSON.stringify(
          {
            version,
            platform: `${platform} ${arch}`,
            terminalCount: 1,
            scrollbackLines: 10000,
            logLimitMiB: 64,
            highlight: "log + addresses",
            stages: results,
            limits:
              "Cumulative streamed output, not full in-memory retention. Only this machine and loopback SSH measured.",
          },
          null,
          2,
        ),
      );
    }
    await page.evaluate(() => {
      const state = (window as any).__textBench;
      cancelAnimationFrame(state.frame);
      state.off();
    });
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    if (timer) clearInterval(timer);
    try {
      await closeCleanly(app);
    } finally {
      await server.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});

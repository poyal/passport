import { electron } from "../../scripts/e2e-electron.mjs";
import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sshFixture } from "../fixtures/ssh-server";
import { closeCleanly } from "../fixtures/electron-exit";
import { renderLatency } from "../fixtures/render-latency";
import { emptyDocument, hostSchema, type Layout } from "../../src/shared/model";
for (const mixed of [false, true])
  test(
    mixed
      ? "thirty minute mixed terminal file and settings soak remains responsive and bounded"
      : "16 visible terminals process 100 KiB/s each for ten minutes",
    async ({}, info) => {
      test.skip(
        process.env.PASSPORT_UI_STRESS !== "1",
        "Run explicitly with PASSPORT_UI_STRESS=1.",
      );
      const seconds = mixed ? 1800 : 600;
      test.setTimeout((seconds + 90) * 1000);
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), "passport-ui-stress-"),
      );
      const server = await sshFixture(directory);
      const app = await electron.launch({
        executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
        args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
        env: {
          ...process.env,
          PASSPORT_DATA_DIR: path.join(directory, "data"),
        },
      });
      let timer: ReturnType<typeof setInterval> | undefined;
      try {
        const version = await app.evaluate(({ app }) => app.getVersion());
        await app.evaluate(({ dialog }) => {
          dialog.showMessageBox = async () => ({
            response: 1,
            checkboxChecked: false,
          });
        });
        const page = await app.firstWindow();
        await page.getByRole("button", { name: "호스트", exact: true }).click();
        await page.waitForLoadState("domcontentloaded");
        await expect(
          page.getByRole("heading", { name: "호스트", exact: true }),
        ).toBeVisible();
        const hosts = Array.from({ length: 500 }, (_, i) =>
          hostSchema.parse({
            id: randomUUID(),
            name: `성능 검증 ${String(i).padStart(3, "0")}`,
            address: "127.0.0.1",
            port: server.port,
            username: "tester",
          }),
        );
        const leaves: Layout[] = hosts
          .slice(0, 16)
          .map((h) => ({ kind: "pane", id: randomUUID(), hostId: h.id }));
        const tree = (nodes: Layout[], depth = 0): Layout =>
          nodes.length === 1
            ? nodes[0]
            : {
                kind: "split",
                id: randomUUID(),
                direction: depth % 2 ? "vertical" : "horizontal",
                ratio: 0.5,
                children: [
                  tree(nodes.slice(0, nodes.length / 2), depth + 1),
                  tree(nodes.slice(nodes.length / 2), depth + 1),
                ],
              };
        const workspace = {
          id: randomUUID(),
          name: "16개 터미널 부하 검증",
          root: tree(leaves),
        };
        await page.evaluate(
          async (document) => {
            const current = await window.passport.call("bootstrap", undefined);
            await window.passport.call("save", {
              ...document,
              revision: current.document.revision,
            });
          },
          {
            ...emptyDocument(),
            settings: {
              ...emptyDocument().settings,
              sessionResume: false,
              appearance: {
                ...emptyDocument().settings.appearance,
                highlight: "log" as const,
                highlightAddresses: true,
              },
            },
            hosts,
            workspaces: [workspace],
          },
        );
        await page.reload();
        await page.locator(".workspace-tab>button").first().click();
        const received = Array<number>(16).fill(0);
        const observeOutput = () =>
          page.evaluate(
            (ids) => {
              const counts = ((window as any).__soakReceived =
                Object.fromEntries(ids.map((id) => [id, 0])));
              window.passport.onEvent((event) => {
                if (event.kind === "output" && Object.hasOwn(counts, event.id))
                  counts[event.id] += event.bytes;
              });
            },
            leaves.map((p) => p.id),
          );
        const collectOutput = async () => {
          const counts = await page.evaluate(
            () => (window as any).__soakReceived as Record<string, number>,
          );
          leaves.forEach((pane, index) => {
            received[index] += counts[pane.id];
          });
        };
        await observeOutput();
        const connectPanes = () =>
          page.evaluate(
            async (leaves) => {
              // Keep fixture channel order equal to pane order for render probes.
              for (const p of leaves)
                await window.passport.call("session.connect", {
                  id: p.id,
                  hostId: p.hostId,
                  secret: {
                    type: "password",
                    password: "test-only-password",
                    privateKey: "",
                    passphrase: "",
                  },
                });
            },
            leaves.filter(
              (n): n is Extract<Layout, { kind: "pane" }> => n.kind === "pane",
            ),
          );
        await connectPanes();
        await expect.poll(() => server.shells.length).toBe(16);
        await expect(page.locator(".terminal-pane")).toHaveCount(16);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        // Row 1 is a persistent input-echo probe; sustained output scrolls below it.
        let channels = server.shells.slice(-16);
        channels[0].write("\x1b[2;r\x1b[2;1H");
        const connectFiles = () =>
          page.evaluate(
            (hostId) =>
              window.passport.call("files.connect", {
                hostId,
                secret: {
                  type: "password",
                  password: "test-only-password",
                  privateKey: "",
                  passphrase: "",
                },
              }),
            hosts[0].id,
          );
        let endpoint = mixed ? await connectFiles() : undefined;
        const chunk = Buffer.alloc(10240);
        const line = Buffer.from(
          "2026-09-29 INFO passport throughput validation 0123456789 abcdefghijklmnopqrstuvwxyz\r\n",
        );
        for (let p = 0; p < chunk.length; p += line.length) line.copy(chunk, p);
        const blocked = new Set<number>(),
          counts = Array(16).fill(0),
          pauses = Array(16).fill(0);
        const start = Date.now();
        let timerTicks = 0;
        let reconnecting = false;
        timer = setInterval(() => {
          if (reconnecting) return;
          timerTicks++;
          // Schedule by elapsed time so late Windows timer callbacks do not lower the requested rate.
          const target = Math.floor((Date.now() - start) / 100) * chunk.length;
          channels.forEach((shell, i) => {
            if (blocked.has(i)) return;
            while (counts[i] + chunk.length <= target) {
              counts[i] += chunk.length;
              if (!shell.write(chunk)) {
                pauses[i]++;
                blocked.add(i);
                shell.once("drain", () => blocked.delete(i));
                break;
              }
            }
          });
        }, 100);
        const samples: number[] = [],
          rendered: number[] = [],
          memory: { second: number; kib: number }[] = [],
          actions: string[] = [];
        for (let i = 0; i < seconds; i++) {
          const delay = await renderLatency(
            page,
            leaves[0].id,
            `I${i.toString(36).padStart(4, "0")}`,
          );
          samples.push(delay.ipc);
          rendered.push(delay.rendered);
          if (mixed && i % 60 === 30) {
            const filename = `soak-${i}-한글.txt`;
            await page.evaluate(
              async ({ id, filename, iteration }) => {
                await window.passport.call("files.action", {
                  id,
                  action: "touch",
                  paths: ["/"],
                  name: filename,
                });
                await window.passport.call("files.action", {
                  id,
                  action: "rename",
                  paths: ["/" + filename],
                  name: "renamed-" + filename,
                });
                const listed = await window.passport.call("files.list", {
                  id,
                  path: "/",
                });
                if (
                  !listed.entries.some((e) => e.name === "renamed-" + filename)
                )
                  throw new Error("Soak file missing from listing");
                const { document } = await window.passport.call(
                  "bootstrap",
                  undefined,
                );
                document.settings.appearance.fontSize = iteration % 2 ? 13 : 14;
                document.settings.colorMode = iteration % 2 ? "light" : "dark";
                await window.passport.call("save", document);
              },
              { id: endpoint!.id, filename, iteration: Math.floor(i / 60) },
            );
            expect(
              (
                await fs.stat(path.join(directory, "renamed-" + filename))
              ).isFile(),
            ).toBe(true);
            await page.evaluate(
              ({ id, filename }) =>
                window.passport.call("files.action", {
                  id,
                  action: "delete",
                  paths: ["/renamed-" + filename],
                }),
              { id: endpoint!.id, filename },
            );
            await expect(
              fs.stat(path.join(directory, "renamed-" + filename)),
            ).rejects.toThrow();
            await app.evaluate(
              ({ BrowserWindow }, iteration) =>
                BrowserWindow.getAllWindows()[0].setSize(
                  iteration % 2 ? 1440 : 1600,
                  iteration % 2 ? 900 : 1000,
                ),
              Math.floor(i / 60),
            );
            await page.evaluate(async () => {
              await document.fonts.ready;
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve()),
                ),
              );
            });
            channels[0].write("\x1b[2;r\x1b[2;1H");
            actions.push(
              `minute ${Math.floor(i / 60)}: SFTP create/rename/list/delete, appearance, native resize`,
            );
          }
          if (mixed && i > 0 && i % 300 === 0) {
            reconnecting = true;
            const oldChannels = channels;
            const closedChannels = new Set();
            for (const channel of oldChannels)
              channel.once("close", () => closedChannels.add(channel));
            const oldCount = server.shells.length;
            await collectOutput();
            await page.reload();
            await page.locator(".workspace-tab>button").first().click();
            await observeOutput();
            await expect(page.locator(".terminal-pane")).toHaveCount(16);
            // Navigation intentionally releases live resources. Reconnect with
            // explicit fixture credentials and verify the old channels closed.
            await expect
              .poll(() => closedChannels.size)
              .toBe(oldChannels.length);
            await connectPanes();
            await expect.poll(() => server.shells.length).toBe(oldCount + 16);
            channels = server.shells.slice(-16);
            blocked.clear();
            endpoint = await connectFiles();
            channels[0].write("\x1b[2;r\x1b[2;1H");
            reconnecting = false;
            actions.push(
              `second ${i}: renderer reload, 16 old channels released, SSH/SFTP reconnected`,
            );
          }
          if (i % 30 === 0) {
            await expect(
              page.locator(".view:not([hidden]) .terminal-pane"),
            ).toHaveCount(16);
            const kib = await app.evaluate(({ app }) =>
              app
                .getAppMetrics()
                .reduce((sum, p) => sum + p.memory.workingSetSize, 0),
            );
            memory.push({ second: i, kib });
            expect(kib / 1024).toBeLessThan(3072);
            expect(errors).toEqual([]);
            console.log(
              `Terminal ${mixed ? "mixed soak" : "stress"} ${i}/${seconds}`,
            );
          }
          const next = start + (i + 1) * 1000;
          await new Promise((r) =>
            setTimeout(r, Math.max(0, next - Date.now())),
          );
        }
        clearInterval(timer);
        timer = undefined;
        // Sender writes can still be queued in SSH or main. Require every
        // pane's final marker to reach the rendered terminal before measuring.
        for (const [index, channel] of channels.entries()) {
          const marker = `END_${index.toString().padStart(2, "0")}`;
          channel.write(`\r\n${marker}\r\n`);
          await expect(
            page.locator(`[data-pane-id="${leaves[index].id}"] .xterm-rows`),
          ).toContainText(marker);
        }
        await collectOutput();
        const sorted = [...samples].sort((a, b) => a - b),
          p95 = sorted[Math.floor(sorted.length * 0.95)];
        const percentile = (values: number[], p: number) =>
          [...values].sort((a, b) => a - b)[Math.floor(values.length * p)];
        const baseline = memory
          .filter((s) => s.second >= 300 && s.second < (mixed ? 600 : 390))
          .map((s) => s.kib);
        const final = memory
          .filter((s) => s.second >= seconds - (mixed ? 300 : 90))
          .map((s) => s.kib);
        const growth =
          (percentile(final, 0.5) - percentile(baseline, 0.5)) / 1024;
        const result = {
          durationMs: Date.now() - start,
          version,
          platform: process.platform,
          arch: process.arch,
          highlight: "log + addresses",
          panes: 16,
          hostCount: 500,
          bytesPerSession: counts,
          receivedBytesPerSession: received,
          targetBytesPerSession: seconds * 100 * 1024,
          timerTicks,
          backpressurePauses: pauses,
          inputLoopbackP95Ms: p95,
          renderP95Ms: percentile(rendered, 0.95),
          renderMaxMs: Math.max(...rendered),
          peakWorkingSetMiB: Math.round(
            Math.max(...memory.map((s) => s.kib)) / 1024,
          ),
          lastWorkingSetMiB: Math.round(memory.at(-1)!.kib / 1024),
          workingSetGrowthMiB: growth,
          memory,
          actions,
          note: "Loopback SSH; render latency observes the reserved probe row DOM then requestAnimationFrame. Physical key/IME and remote WAN are separate checks.",
        };
        await fs.mkdir(info.outputDir, { recursive: true });
        await fs.writeFile(
          info.outputPath("terminal-stress.json"),
          JSON.stringify(result, null, 2),
        );
        expect(p95).toBeLessThan(100);
        expect(percentile(rendered, 0.95)).toBeLessThan(250);
        expect(Math.max(...rendered)).toBeLessThan(3000);
        expect(growth).toBeLessThanOrEqual(256);
        expect(Math.min(...counts)).toBeGreaterThan(
          seconds * 100 * 1024 * 0.95,
        );
        expect(Math.min(...received)).toBeGreaterThan(
          seconds * 100 * 1024 * 0.95,
        );
        // Without intentional renderer reloads, every payload byte must reach
        // the renderer. Received bytes also include banners and echo probes.
        if (!mixed)
          received.forEach((bytes, index) =>
            expect(bytes).toBeGreaterThanOrEqual(counts[index]),
          );
        await page.screenshot({ path: info.outputPath("terminal-stress.png") });
      } finally {
        if (timer) clearInterval(timer);
        try {
          await closeCleanly(app);
        } finally {
          await server.close();
          await fs.rm(directory, { recursive: true, force: true });
        }
      }
    },
  );

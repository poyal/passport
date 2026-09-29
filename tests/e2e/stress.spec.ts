import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { sshFixture } from "../fixtures/ssh-server";
import { closeCleanly } from "../fixtures/electron-exit";
import { emptyDocument, hostSchema, type Layout } from "../../src/shared/model";
test("16 visible terminals process 100 KiB/s each for ten minutes", async () => {
  test.skip(
    process.env.PASSPORT_UI_STRESS !== "1",
    "Run explicitly with PASSPORT_UI_STRESS=1.",
  );
  test.setTimeout(660000);
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-ui-stress-"),
  );
  const server = await sshFixture(directory);
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, PASSPORT_DATA_DIR: path.join(directory, "data") },
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    });
    const page = await app.firstWindow();
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
    await page.evaluate(
      async (leaves) => {
        await Promise.all(
          leaves.map((p) =>
            window.passport.call("session.connect", {
              id: p.id,
              hostId: p.hostId,
              secret: {
                type: "password",
                password: "test-only-password",
                privateKey: "",
                passphrase: "",
              },
            }),
          ),
        );
      },
      leaves.filter(
        (n): n is Extract<Layout, { kind: "pane" }> => n.kind === "pane",
      ),
    );
    await expect.poll(() => server.shells.length).toBe(16);
    await expect(page.locator(".terminal-pane")).toHaveCount(16);
    const chunk = Buffer.alloc(10240);
    const line = Buffer.from(
      "2026-09-29 INFO passport throughput validation 0123456789 abcdefghijklmnopqrstuvwxyz\r\n",
    );
    for (let p = 0; p < chunk.length; p += line.length) line.copy(chunk, p);
    const blocked = new Set<number>(),
      counts = Array(16).fill(0);
    timer = setInterval(() => {
      server.shells.forEach((shell, i) => {
        if (blocked.has(i)) return;
        counts[i] += chunk.length;
        if (!shell.write(chunk)) {
          blocked.add(i);
          shell.once("drain", () => blocked.delete(i));
        }
      });
    }, 100);
    const samples: number[] = [],
      memory: number[] = [];
    const start = Date.now();
    for (let i = 0; i < 600; i++) {
      const delay = await page.evaluate(
        async ({ id, marker }) =>
          new Promise<number>((resolve, reject) => {
            let output = "";
            const start = performance.now();
            const timeout = setTimeout(() => {
              off();
              reject(new Error("input response timeout"));
            }, 3000);
            const off = window.passport.onEvent((e) => {
              if (e.kind === "output" && e.id === id) {
                output = (output + e.data).slice(-131072);
                if (output.includes(marker)) {
                  off();
                  clearTimeout(timeout);
                  resolve(performance.now() - start);
                }
              }
            });
            void window.passport
              .call("session.input", { id, data: marker })
              .catch(reject);
          }),
        { id: leaves[0].id, marker: `[INPUT-${i}]` },
      );
      samples.push(delay);
      if (i % 30 === 0) {
        await expect(
          page.locator(".view:not([hidden]) .terminal-pane"),
        ).toHaveCount(16);
        memory.push(
          await app.evaluate(({ app }) =>
            app
              .getAppMetrics()
              .reduce((sum, p) => sum + p.memory.workingSetSize, 0),
          ),
        );
        console.log(`Terminal stress ${i}/600`);
      }
      const next = start + (i + 1) * 1000;
      await new Promise((r) => setTimeout(r, Math.max(0, next - Date.now())));
    }
    clearInterval(timer);
    timer = undefined;
    const sorted = [...samples].sort((a, b) => a - b),
      p95 = sorted[Math.floor(sorted.length * 0.95)];
    const result = {
      durationMs: Date.now() - start,
      version: "0.3.0",
      highlight: "log + addresses",
      panes: 16,
      hostCount: 500,
      bytesPerSession: counts,
      inputLoopbackP95Ms: p95,
      peakWorkingSetMiB: Math.round(Math.max(...memory) / 1024),
      lastWorkingSetMiB: Math.round(memory.at(-1)! / 1024),
      note: "Loopback IPC/SSH response includes local network delay. Windows/Intel Mac not measured.",
    };
    await fs.mkdir("test-results", { recursive: true });
    await fs.writeFile(
      "test-results/terminal-stress.json",
      JSON.stringify(result, null, 2),
    );
    expect(p95).toBeLessThan(100);
    expect(Math.min(...counts)).toBeGreaterThan(600 * 100 * 1024 * 0.95);
    await page.screenshot({ path: "test-results/terminal-stress.png" });
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

import { electron } from "../../scripts/e2e-electron.mjs";
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID as id } from "node:crypto";
import { type Workspace, type Layout, type Pane } from "../../src/shared/model";
import { LOCAL_HOST_ID } from "../../src/shared/advanced";
import { panes } from "../../src/shared/layout";
import { closeCleanly } from "../fixtures/electron-exit";

const pane = (): Pane => ({
  kind: "pane",
  id: id(),
  hostId: LOCAL_HOST_ID,
  local: { shell: "default", cwd: "" },
});
const split = (
  a: Layout,
  b: Layout,
  direction: "horizontal" | "vertical" = "horizontal",
): Layout => ({
  kind: "split",
  id: id(),
  direction,
  ratio: 0.5,
  children: [a, b],
});
const save = async (page: Page, workspaces: Workspace[]) =>
  page.evaluate(async (workspaces) => {
    const boot = await window.passport.call("bootstrap", undefined);
    boot.document.workspaces = workspaces;
    await window.passport.call("save", boot.document);
  }, workspaces);

for (const direction of ["horizontal", "vertical"] as const) {
  test(`nested ${direction} groups fill the available space even when minimum panel sizes constrain a track`, async ({}, info) => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "passport-layout-grid-"),
    );
    const app = await electron.launch({
      executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
      args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
      env: {
        ...process.env,
        PASSPORT_DATA_DIR: directory,
        PASSPORT_DISABLE_UPDATE_CHECK: "1",
      },
    });
    try {
      const page = await app.firstWindow();
      await expect(
        page.getByRole("button", { name: "새 로컬 터미널", exact: true }),
      ).toBeVisible();
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(1440, 900),
      );
      const root = split(pane(), split(pane(), pane(), direction), direction);
      const workspace = { id: id(), name: "Nested group", root };
      await save(page, [workspace]);
      await page
        .getByRole("button", { name: "Nested group 3", exact: true })
        .click();
      await expect(page.locator(".terminal-pane")).toHaveCount(3);
      await expect
        .poll(() =>
          page.locator(".split-layout").evaluateAll(
            (elements, direction) =>
              elements.map((element) => {
                const parent = element.getBoundingClientRect();
                const first =
                  element.firstElementChild!.getBoundingClientRect();
                const last = element.lastElementChild!.getBoundingClientRect();
                return direction === "horizontal"
                  ? Math.abs(parent.left - first.left) < 1 &&
                      Math.abs(parent.right - last.right) < 1
                  : Math.abs(parent.top - first.top) < 1 &&
                      Math.abs(parent.bottom - last.bottom) < 1;
              }),
            direction,
          ),
        )
        .toEqual([true, true]);
      const button = page.getByRole("button", {
        name: "템플릿 저장",
        exact: true,
      });
      await expect(button).toHaveText("");
      await expect(button).toBeInViewport();
      await page.screenshot({
        path: info.outputPath(`nested-${direction}.png`),
      });
      await button.click();
      await expect(
        page.getByRole("dialog", { name: "템플릿 저장" }),
      ).toBeVisible();
      await expect(page.getByLabel("저장할 탭")).toHaveValue(workspace.id);
      await page.getByRole("button", { name: "취소", exact: true }).click();
    } finally {
      await closeCleanly(app);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}

test("grouped tabs can reorder but cannot merge; their individual panels can still move", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "passport-layout-drag-"),
  );
  const app = await electron.launch({
    executablePath: process.env.PASSPORT_E2E_EXECUTABLE,
    args: process.env.PASSPORT_E2E_EXECUTABLE ? [] : ["."],
    env: {
      ...process.env,
      PASSPORT_DATA_DIR: directory,
      PASSPORT_DISABLE_UPDATE_CHECK: "1",
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByRole("button", { name: "새 로컬 터미널", exact: true }),
    ).toBeVisible();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1440, 900),
    );
    const a = pane(),
      b = pane(),
      c = pane();
    const target = { id: id(), name: "Target", root: a };
    const group = { id: id(), name: "Group", root: split(b, c) };
    await save(page, [target, group]);
    const drag = await page.evaluateHandle(() => new DataTransfer());
    const sourceTab = page
      .locator(".workspace-tab")
      .filter({ hasText: "Group" });
    const targetTab = page
      .locator(".workspace-tab")
      .filter({ hasText: "Target" });
    await sourceTab.dispatchEvent("dragstart", { dataTransfer: drag });
    expect(
      await drag.evaluate((value) =>
        value.types.includes("application/x-passport-group"),
      ),
    ).toBe(true);
    await targetTab.dispatchEvent("dragover", { dataTransfer: drag });
    await expect(targetTab).toHaveClass(/active/);
    const destination = page.locator(`[data-pane-id="${a.id}"]`);
    const rect = (await destination.boundingBox())!;
    const drop = {
      dataTransfer: drag,
      clientX: rect.x + rect.width - 12,
      clientY: rect.y + rect.height / 2,
    };
    await destination.dispatchEvent("dragover", drop);
    await expect(page.locator(".drop-zone")).toHaveCount(0);
    // A forced drop must also be rejected, even without the browser's dragover gate.
    await destination.dispatchEvent("drop", drop);
    await expect(page.locator(".toast")).toContainText("묶인 탭 전체");
    expect(
      (await page.evaluate(() => window.passport.call("bootstrap", undefined)))
        .document.workspaces,
    ).toEqual([target, group]);
    await targetTab.dispatchEvent("drop", { dataTransfer: drag });
    await expect
      .poll(async () =>
        (
          await page.evaluate(() =>
            window.passport.call("bootstrap", undefined),
          )
        ).document.workspaces.map((w) => w.id),
      )
      .toEqual([group.id, target.id]);
    await sourceTab.locator("button").first().click();
    const individual = await page.evaluateHandle(() => new DataTransfer());
    await page
      .locator(`[data-pane-id="${b.id}"] .pane-title`)
      .dispatchEvent("dragstart", { dataTransfer: individual });
    expect(
      await individual.evaluate((value) =>
        value.types.includes("application/x-passport-group"),
      ),
    ).toBe(false);
    await targetTab.dispatchEvent("dragover", { dataTransfer: individual });
    await expect(targetTab).toHaveClass(/active/);
    await destination.dispatchEvent("drop", {
      ...drop,
      dataTransfer: individual,
    });
    await expect
      .poll(async () =>
        panes(
          (
            await page.evaluate(() =>
              window.passport.call("bootstrap", undefined),
            )
          ).document.workspaces.find((w) => w.id === target.id)!.root,
        ).map((p) => p.id),
      )
      .toEqual([a.id, b.id]);
    const remaining = (
      await page.evaluate(() => window.passport.call("bootstrap", undefined))
    ).document.workspaces.find((w) => w.id === group.id)!;
    expect(panes(remaining.root).map((p) => p.id)).toEqual([c.id]);
  } finally {
    await closeCleanly(app);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

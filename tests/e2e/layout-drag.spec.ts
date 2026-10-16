import { reusableApp } from "../fixtures/reusable-app";
import {
  test,
  expect,
  type Page,
  type Locator,
  type JSHandle,
} from "@playwright/test";
import { randomUUID as id } from "node:crypto";
import { type Workspace, type Layout, type Pane } from "../../src/shared/model";
import { LOCAL_HOST_ID } from "../../src/shared/advanced";
import { panes } from "../../src/shared/layout";

const suite = reusableApp({ name: "layout" });

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
    const { application: app, page } = suite;
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
      .getByRole("button", { name: "Nested group", exact: true })
      .click();
    await expect(page.locator(".terminal-pane")).toHaveCount(3);
    await expect
      .poll(() =>
        page.locator(".split-layout").evaluateAll(
          (elements, direction) =>
            elements.map((element) => {
              const parent = element.getBoundingClientRect();
              const first = element.firstElementChild!.getBoundingClientRect();
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
  });
}

test("dragging a local tab or panel onto itself shows no split target and never saves", async () => {
  const { page } = suite;
  const a = pane(),
    b = pane();
  const first = { id: id(), name: "First local", root: a };
  const second = { id: id(), name: "Second local", root: b };
  await save(page, [first, second]);
  const firstTab = page
    .locator(".workspace-tab")
    .filter({ hasText: first.name });
  const secondTab = page
    .locator(".workspace-tab")
    .filter({ hasText: second.name });
  await firstTab.getByRole("button", { name: first.name, exact: true }).click();
  const target = page.locator(`[data-pane-id="${a.id}"]`);
  const rect = (await target.boundingBox())!;
  const before = await page.evaluate(
    async () => (await window.passport.call("bootstrap", undefined)).document,
  );
  const acceptsDrop = (
    target: Locator,
    transfer: JSHandle<DataTransfer>,
    position: { clientX?: number; clientY?: number } = {},
  ) =>
    target.evaluate(
      (element, { transfer, position }) => {
        const event = new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          ...position,
        });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      },
      { transfer, position },
    );
  for (const source of [firstTab, target.locator(".pane-title")]) {
    const drag = await page.evaluateHandle(() => new DataTransfer());
    await source.dispatchEvent("dragstart", { dataTransfer: drag });
    // Native dragover exposes format names but protects the payload until drop.
    const hover = await page.evaluateHandle((drag) => {
      const value = new DataTransfer();
      for (const type of drag.types) value.setData(type, "");
      return value;
    }, drag);
    expect(await acceptsDrop(firstTab, hover)).toBe(false);
    for (const [x, y] of [
      [12, rect.height / 2],
      [rect.width - 12, rect.height / 2],
      [rect.width / 2, 12],
      [rect.width / 2, rect.height - 12],
    ]) {
      const position = { clientX: rect.x + x, clientY: rect.y + y };
      expect(await acceptsDrop(target, hover, position)).toBe(false);
      await expect(page.locator(".drop-zone")).toHaveCount(0);
      // Even a forced drop bypassing the browser's gate must not save a no-op.
      await target.dispatchEvent("drop", { ...position, dataTransfer: drag });
      expect(
        await page.evaluate(
          async () =>
            (await window.passport.call("bootstrap", undefined)).document,
        ),
      ).toEqual(before);
      await expect(page.locator(".toast")).toHaveCount(0);
    }
    await source.dispatchEvent("dragend", { dataTransfer: drag });
    await hover.dispose();
    await drag.dispose();
  }
  // Another local tab remains a valid split source; cancellation clears its hint.
  const drag = await page.evaluateHandle(() => new DataTransfer());
  await secondTab.dispatchEvent("dragstart", { dataTransfer: drag });
  const position = {
    dataTransfer: drag,
    clientX: rect.x + rect.width - 12,
    clientY: rect.y + rect.height / 2,
  };
  expect(await acceptsDrop(target, drag, position)).toBe(true);
  await expect(target.locator(".drop-zone.right")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".drop-zone")).toHaveCount(0);
  await secondTab.dispatchEvent("dragstart", { dataTransfer: drag });
  await target.dispatchEvent("dragover", position);
  await target.dispatchEvent("drop", position);
  await expect
    .poll(async () => {
      const { document } = await page.evaluate(() =>
        window.passport.call("bootstrap", undefined),
      );
      return document.workspaces.map((w) => ({
        id: w.id,
        panes: panes(w.root).map((p) => p.id),
      }));
    })
    .toEqual([{ id: first.id, panes: [a.id, b.id] }]);
  await expect(page.locator(".drop-zone")).toHaveCount(0);
  await drag.dispose();
});

test("grouped tabs can reorder but cannot merge; their individual panels can still move", async () => {
  const { application: app, page } = suite;
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
  const sourceTab = page.locator(".workspace-tab").filter({ hasText: "Group" });
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
        await page.evaluate(() => window.passport.call("bootstrap", undefined))
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
});

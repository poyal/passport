import { reusableApp } from "../fixtures/reusable-app";
import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const suite = reusableApp({
  name: "local-colors",
  env: {
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    CLICOLOR: "0",
    TERM: "dumb",
    COLORTERM: "",
  },
});

for (const mode of ["plain", "ai-profile", "explicit-no-color"] as const) {
  test(`local CLI colors survive a colorless app launcher: ${mode}`, async ({}, info) => {
    const { application, page, directory } = suite;
    const fixture = path.join(directory, "colors.sh");
    await fs.writeFile(
      fixture,
      `
printf '\\nCAPS:%s/%s/%s\\n' "$TERM" "$TERM_PROGRAM" "$COLORTERM"
if [ -n "$NO_COLOR" ]; then
  printf 'EXPLICIT_NO_COLOR\\n'
else
  printf '\\033[38;2;230;80;90mRGB_RED\\033[0m\\n'
  printf '\\033[38;2;80;210;130;48;2;0;45;10mRGB_GREEN_DIFF\\033[0m\\n'
  printf '\\033[38;5;45mINDEXED_CYAN\\033[0m\\n'
fi
printf 'COLOR_FIXTURE_DONE\\n'
`,
    );
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    });
    await page.waitForSelector(".home-view");
    await page.evaluate(async (mode) => {
      const b = await window.passport.call("bootstrap", undefined);
      b.document.settings.appearance.theme = "gruvbox-dark";
      b.document.settings.terminal.shell =
        b.platform === "win32" ? "passport-bash" : "zsh";
      b.document.settings.terminal.profileIds =
        mode === "plain" ? [] : ["ai-notifications"];
      if (mode === "explicit-no-color") {
        b.document.settings.terminal.profiles.push({
          id: "monochrome",
          name: "명시적 색상 끄기",
          revision: 1,
          origin: "user",
          platforms: ["darwin", "win32"],
          shells: ["zsh", "passport-bash"],
          entries: [
            { kind: "env", name: "NO_COLOR", value: "1", overwrite: true },
          ],
        });
        b.document.settings.terminal.profileIds.push("monochrome");
      }
      await window.passport.call("save", b.document);
    }, mode);
    await page
      .getByRole("button", { name: "새 로컬 터미널", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.passport.call("bootstrap", undefined))
              .sessionStates[0]?.environment?.status,
        ),
      )
      .toBe("ready");
    const pane = (
      await page.evaluate(() => window.passport.call("bootstrap", undefined))
    ).sessionStates[0].id;
    const quoted =
      "'" + fixture.replace(/\\/g, "/").split("'").join("'\"'\"'") + "'";
    await page.evaluate(
      ({ id, command }) =>
        window.passport.call("session.input", { id, data: command + "\r" }),
      { id: pane, command: `sh ${quoted}` },
    );
    const rows = page.locator(".xterm-rows");
    await expect(rows).toContainText("COLOR_FIXTURE_DONE");
    await expect(rows).toContainText("CAPS:xterm-256color/Passport/truecolor");
    if (mode === "explicit-no-color") {
      await expect(rows).toContainText("EXPLICIT_NO_COLOR");
      await expect(rows).not.toContainText("RGB_RED");
    } else {
      for (const [marker, color, background] of [
        ["RGB_RED", "rgb(230, 80, 90)", ""],
        ["RGB_GREEN_DIFF", "rgb(80, 210, 130)", "rgb(0, 45, 10)"],
        ["INDEXED_CYAN", "rgb(0, 215, 255)", ""],
      ]) {
        const span = rows.locator("span").filter({ hasText: marker }).first();
        await expect(span).toHaveCSS("color", color);
        if (background)
          await expect(span).toHaveCSS("background-color", background);
      }
    }
    await page.screenshot({
      path: info.outputPath(`local-colors-${mode}.png`),
    });
  });
}

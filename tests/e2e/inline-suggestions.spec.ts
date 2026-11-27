import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { reusableApp } from "../fixtures/reusable-app";

const home = path.join(os.tmpdir(), "passport-suggestions-" + randomUUID());
test.beforeAll(async () => {
  await fs.mkdir(home);
  await fs.writeFile(
    path.join(home, "password.sh"),
    'saved=$(stty -g)\ntrap \'stty "$saved"\' EXIT\nstty -echo\ntouch password-ready\nIFS= read -r value\nprintf %s "$value" > password-result\n',
  );
  await fs.writeFile(
    path.join(home, ".zshrc"),
    "HISTFILE=/dev/null\nbindkey -e\nPROMPT='suggest> '\n",
  );
  await fs.writeFile(
    path.join(home, ".bash_profile"),
    "HISTFILE=/dev/null\nPS1='suggest> '\n",
  );
  await fs.writeFile(
    path.join(home, "child.sh"),
    [
      "mode=$1",
      "saved=$(stty -g)",
      "trap 'stty \"$saved\"' EXIT",
      '[ "$mode" = alt ] && printf "\\033[?1049h"',
      "stty -echo -icanon min 1 time 0",
      'touch "ready-$mode"',
      'dd bs=1 count=3 of="key-$mode" 2>/dev/null',
      '[ "$mode" = alt ] && printf "\\033[?1049l"',
      'touch "done-$mode"',
    ].join("\n"),
  );
});
const suite = reusableApp({
  name: "inline-suggestions",
  env:
    process.platform === "win32"
      ? {
          HOME: home,
          XDG_CACHE_HOME: path.join(home, ".cache"),
          XDG_STATE_HOME: path.join(home, ".local", "state"),
        }
      : { ZDOTDIR: home },
});
test.afterAll(async () => fs.rm(home, { recursive: true, force: true }));

test("accepts local path and history suggestions only in the shell editor", async () => {
  const { page } = suite;
  await fs.writeFile(path.join(home, "example 한글.txt"), "inline-path-ok\n");
  await page.evaluate(async (cwd) => {
    const boot = await window.passport.call("bootstrap", undefined);
    Object.assign(boot.document.settings.terminal, {
      cwd,
      shell: boot.platform === "win32" ? "passport-bash" : "zsh",
      profileIds: [],
    });
    await window.passport.call("save", boot.document);
  }, home);
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page
    .locator(".settings-sidebar")
    .getByRole("button", { name: "로컬 터미널", exact: true })
    .click();
  const toggle = page.getByRole("switch", { name: "로컬 셸 인라인 자동완성" });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page
    .getByRole("button", { name: "새 로컬 터미널", exact: true })
    .click();
  const rows = page.locator(".xterm-rows");
  const input = page.locator(".xterm-helper-textarea");
  await expect(rows).toContainText("suggest>", { timeout: 30000 });
  await input.focus();
  // Wait for the first interactive edit cycle, including a cold ble.sh cache.
  await input.pressSequentially("pwd > shell-ready", { delay: 25 });
  await input.press("Enter");
  await expect
    .poll(
      () =>
        fs.stat(path.join(home, "shell-ready")).then(
          () => true,
          () => false,
        ),
      { timeout: 20000 },
    )
    .toBe(true);
  if (process.platform === "win32") {
    expect(
      await fs.readdir(path.join(home, ".cache", "blesh")),
    ).not.toHaveLength(0);
  }
  await input.pressSequentially("cat exa", { delay: 50 });
  await expect(rows).toContainText("한글.txt", { timeout: 20000 });
  await input.press("ArrowRight");
  await expect(rows).not.toContainText("inline-path-ok");
  await input.press("Enter");
  await expect(rows).toContainText("inline-path-ok");

  await input.pressSequentially("echo ac");
  await input.press("ArrowLeft");
  await input.pressSequentially("b");
  await input.press("ArrowRight");
  await input.pressSequentially("d > edited");
  await input.press("Enter");
  const readFile = (name: string) =>
    fs.readFile(path.join(home, name), "utf8").catch(() => "");
  await expect.poll(() => readFile("edited")).toBe("abcd\n");

  await input.pressSequentially("sh password.sh");
  await input.press("Enter");
  await expect
    .poll(() =>
      fs.access(path.join(home, "password-ready")).then(
        () => true,
        () => false,
      ),
    )
    .toBe(true);
  await input.pressSequentially("probe-hidden-value");
  await input.press("Enter");
  await expect
    .poll(() => readFile("password-result"))
    .toBe("probe-hidden-value");
  await input.pressSequentially("probe-hidden");
  await expect(rows).not.toContainText("probe-hidden-value");
  await input.press("Control+u");

  // Both kinds of foreground program must receive the actual right-arrow bytes.
  for (const mode of ["normal", "alt"]) {
    await input.pressSequentially("sh child.sh " + mode);
    await input.press("Enter");
    const exists = (name: string) =>
      fs.access(path.join(home, name)).then(
        () => true,
        () => false,
      );
    await expect.poll(() => exists("ready-" + mode)).toBe(true);
    await input.press("ArrowRight");
    await expect.poll(() => exists("done-" + mode)).toBe(true);
    expect(await fs.readFile(path.join(home, "key-" + mode), "utf8")).toMatch(
      /^\x1b(?:\[|O)C$/,
    );
  }

  const seed = "echo history-ok >> accepted";
  const result = path.join(home, "accepted");
  await input.pressSequentially(seed, { delay: 10 });
  await input.press("Enter");
  const read = () => fs.readFile(result, "utf8").catch(() => "");
  await expect.poll(read).toBe("history-ok\n");
  await input.press("Control+l");
  await input.pressSequentially("echo hist", { delay: 25 });
  await expect(rows).toContainText(">> accepted");
  await input.press("ArrowRight");
  expect(await read()).toBe("history-ok\n");
  await input.press("Enter");
  await expect.poll(read).toBe("history-ok\nhistory-ok\n");
});

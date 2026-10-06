import { expect, type Page } from "@playwright/test";

// The connected badge confirms PTY attachment, before Windows Bash/readline
// has finished starting. Call only for the default local Passport Bash pane.
export async function waitForLocalPrompt(page: Page) {
  if (process.platform === "win32")
    await expect(page.locator(".view:not([hidden]) .xterm-rows")).toContainText(
      /\$\s*$/,
    );
}

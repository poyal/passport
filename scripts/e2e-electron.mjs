import { _electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { e2eMode } from "./e2e-mode.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

export function electronLaunchEnv(extra = {}) {
  const mode = e2eMode();
  const env = { ...process.env, ...extra };
  if (!env.PASSPORT_DATA_DIR)
    throw new Error("E2E launch requires an isolated PASSPORT_DATA_DIR");
  if (mode === "desktop") delete env.PASSPORT_E2E_WINDOW_MODE;
  else env.PASSPORT_E2E_WINDOW_MODE = mode;
  return env;
}

export async function assertBackgroundCapable(executable) {
  let main;
  if (executable) {
    const resources =
      process.platform === "darwin"
        ? path.resolve(path.dirname(executable), "../Resources")
        : path.resolve(path.dirname(executable), "resources");
    const { extractFile } = await import("@electron/asar");
    main = extractFile(
      path.join(resources, "app.asar"),
      "dist/main/index.cjs",
    ).toString();
  } else
    main = await fs.readFile(path.join(root, "dist/main/index.cjs"), "utf8");
  if (!main.includes("PASSPORT_E2E_WINDOW_MODE"))
    throw new Error(
      "This build does not support background E2E. Rebuild before testing; refusing to open a foreground window.",
    );
}

// One entry point for source and packaged tests. The presentation mode is set
// before Electron starts, so no window flashes before a later hide() call.
export const electron = {
  async launch(options = {}) {
    const mode = e2eMode();
    const env = electronLaunchEnv(options.env);
    if (mode !== "desktop")
      await assertBackgroundCapable(options.executablePath);
    // Hidden Windows windows otherwise deliver animation frames at 1 Hz,
    // delaying Playwright stability checks. Keep this in the shared test launcher.
    const args = [
      ...(options.args || []),
      ...(process.platform === "win32"
        ? ["--disable-frame-rate-limit", "--disable-gpu-vsync"]
        : []),
    ];
    return _electron.launch({ ...options, args, env });
  },
};

export async function focusTerminalPage(page) {
  // Playwright emulates renderer focus; only the explicit desktop suite may
  // activate the native window. DOM focus still exercises real terminal input.
  if (e2eMode() === "desktop") await page.bringToFront();
}

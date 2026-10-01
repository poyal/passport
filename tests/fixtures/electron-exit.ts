import { expect, type ElectronApplication } from "@playwright/test";
import { once } from "node:events";

export async function closeCleanly(application: ElectronApplication) {
  const child = application.process();
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve([child.exitCode, child.signalCode])
      : once(child, "exit");
  if (child.exitCode === null && child.signalCode === null) {
    // Electron's asynchronous will-quit cleanup can still own native PTYs.
    // Keep the debugger attached until normal cleanup finishes; Playwright's
    // close() disconnects it immediately after requesting app.quit().
    await application.evaluate(({ app }) => {
      setTimeout(() => app.quit(), 0);
    });
  }
  const [code, signal] = await exited;
  await application.close();
  expect(
    { code, signal },
    "Electron must exit normally, including native PTY teardown",
  ).toEqual({ code: 0, signal: null });
}

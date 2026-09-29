import { expect, type ElectronApplication } from "@playwright/test";
import { once } from "node:events";

export async function closeCleanly(application: ElectronApplication) {
  const child = application.process();
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve([child.exitCode, child.signalCode])
      : once(child, "exit");
  await application.close();
  const [code, signal] = await exited;
  expect(
    { code, signal },
    "Electron must exit normally, including native PTY teardown",
  ).toEqual({ code: 0, signal: null });
}

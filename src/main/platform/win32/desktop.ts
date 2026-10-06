import path from "node:path";
import type { DesktopContext, DesktopPlatform } from "../contracts";

const icon = (context: DesktopContext) =>
  context.packaged
    ? path.win32.join(context.resourcesPath, "icon.ico")
    : path.win32.join(context.appPath, "build/icon.ico");
export const windowsDesktop: DesktopPlatform = {
  quitOnLastWindow: true,
  initialize(app) {
    app.setAppUserModelId("io.passport.desktop");
  },
  windowOptions: (context) => ({
    icon: icon(context),
    show: false,
    titleBarStyle: "default",
  }),
  configureWindow(win, context, mode) {
    win.setAppDetails({
      appId: "io.passport.desktop",
      appIconPath: icon(context),
      appIconIndex: 0,
      relaunchCommand: context.packaged
        ? `"${context.executable}"`
        : `"${context.executable}" "${context.appPath}"`,
      relaunchDisplayName: "Passport",
    });
    if (!mode) win.once("ready-to-show", () => win.show());
  },
  openNotificationSettings: (shell) =>
    shell.openExternal("ms-settings:notifications"),
};

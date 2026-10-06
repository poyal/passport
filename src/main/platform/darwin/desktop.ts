import path from "node:path";
import type { DesktopPlatform } from "../contracts";

export const darwinDesktop: DesktopPlatform = {
  quitOnLastWindow: false,
  initialize(app, mode) {
    if (mode) app.setActivationPolicy("accessory");
  },
  windowOptions: ({ appPath }) => ({
    icon: path.posix.join(appPath, "build/icon.png"),
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 14 },
  }),
  configureWindow() {},
  openNotificationSettings: (shell) =>
    shell.openExternal(
      "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
    ),
};

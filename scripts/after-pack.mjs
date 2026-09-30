import path from "node:path";
import { Arch } from "builder-util";
import { prepareWindowsPty } from "./prepare-node-pty.mjs";

export default async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  await prepareWindowsPty(
    path.join(context.packager.projectDir, "node_modules/node-pty"),
    path.join(
      context.appOutDir,
      "resources/app.asar.unpacked/node_modules/node-pty",
    ),
    Arch[context.arch],
  );
}

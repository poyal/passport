import path from "node:path";
import { Arch } from "builder-util";
import { prepareWindowsPty } from "./prepare-node-pty.mjs";
import { patchPtyInput } from "./patch-pty-input.mjs";

export default async function afterPack(context) {
  const destination = path.join(
    context.packager.getResourcesDir(context.appOutDir),
    "app.asar.unpacked/node_modules/node-pty",
  );
  if (context.electronPlatformName === "win32")
    await prepareWindowsPty(
      path.join(context.packager.projectDir, "node_modules/node-pty"),
      destination,
      Arch[context.arch],
    );
  await patchPtyInput(destination);
}

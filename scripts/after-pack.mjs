import path from "node:path";
import { access } from "node:fs/promises";
import { Arch } from "builder-util";
import { prepareWindowsPty } from "./prepare-node-pty.mjs";
import { patchPtyInput } from "./patch-pty-input.mjs";

export default async function afterPack(context) {
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const scripts =
    context.electronPlatformName === "win32"
      ? [
          "enable.bash",
          "bash/ble.sh",
          "bash/lib/core-complete.sh",
          "bash/licenses/LICENSE.md",
          "powershell/enable.ps1",
          "powershell/PathPredictor.cs",
        ]
      : ["enable.zsh", "zsh/zsh-autosuggestions.zsh", "zsh/LICENSE"];
  await Promise.all(
    scripts.map((script) =>
      access(path.join(resources, "terminal/autosuggestions", script)),
    ),
  );
  const destination = path.join(
    resources,
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

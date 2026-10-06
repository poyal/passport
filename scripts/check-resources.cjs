const fs = require("node:fs");
const path = require("node:path");
module.exports = async (context) => {
  const platform = context.electronPlatformName;
  const arch = require("builder-util").Arch[context.arch];
  if (!(
    (platform === "win32" && arch === "x64") ||
    (platform === "darwin" && arch === "arm64")
  ))
    throw new Error(`Unsupported package target: ${platform}-${arch}`);
  const root = path.resolve("resources/terminal");
  const helper = path.join(
    root,
    "helper",
    `${platform}-${arch}`,
    platform === "win32" ? "passport-helper.exe" : "passport-helper",
  );
  if (!fs.existsSync(helper))
    throw new Error(
      `Build the ${platform}-${arch} native helper before packaging.`,
    );
  if (platform === "win32") {
    const pinned = JSON.parse(
      fs.readFileSync(path.join(root, "runtime-manifest.json")),
    );
    const runtime = path.join(root, "runtime", arch);
    const installed = JSON.parse(
      fs.readFileSync(path.join(runtime, "passport-runtime.json")),
    );
    if (
      installed.sha256 !== pinned.assets[arch].sha256 ||
      !fs.existsSync(path.join(runtime, "bin/bash.exe"))
    )
      throw new Error(
        `Run npm run prepare:runtime -- ${arch} before packaging.`,
      );
    if (
      !fs
        .readFileSync(
          path.join(runtime, "etc/profile.d/bash_profile.sh"),
          "utf8",
        )
        .includes("generation is intentionally disabled")
    )
      throw new Error("Portable Git home-file patch missing");
  }
};

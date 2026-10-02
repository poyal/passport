import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { mkdir, copyFile } from "node:fs/promises";
import "./notices.mjs";
import "./patch-ssh2.mjs";
import "./build-helper.mjs";
await mkdir("build", { recursive: true });
await copyFile("design/icons/04-passport-terminal-v2.png", "build/icon.png");
if (process.platform === "win32") {
  const { runIconsTool } =
    await import("app-builder-lib/out/toolsets/icons.js");
  await runIconsTool({
    inputFile: "build/icon.png",
    outputFormat: "ico",
    outDir: "build",
  });
}
await build({
  entryPoints: ["src/main/index.ts"],
  outfile: "dist/main/index.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: [
    "electron",
    "better-sqlite3",
    "ssh2",
    "basic-ftp",
    "font-list",
    "node-pty",
  ],
  sourcemap: true,
});
await build({
  entryPoints: ["src/preload/index.ts"],
  outfile: "dist/preload/index.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  sourcemap: true,
});
await viteBuild();

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getIconsToolsetPath } from "app-builder-lib/out/toolsets/icons.js";

// icons@1.1.0 starts seven ICO resizes concurrently. Caching the resolved Vips
// instance races during the first await and allocates seven 1 GiB WASM heaps.
// Cache its initialization promise instead; leave the verified shared cache
// untouched, and fail closed if an upstream update changes this patch point.
export function singleFlightVips(source) {
  const before = "vipsInstance = await VipsFactory({";
  assert.equal(
    source.split(before).length,
    2,
    "Review icon tool Vips initialization patch",
  );
  assert.ok(source.includes("if (vipsInstance) return vipsInstance;"));
  return source.replace(before, "vipsInstance = VipsFactory({");
}

export async function buildWindowsIcon() {
  const original = await getIconsToolsetPath();
  const directory = path.resolve("build/toolchains/icons-single-flight");
  await fs.mkdir(directory, { recursive: true });
  const source = await fs.readFile(path.join(original, "icon-tool.js"), "utf8");
  for (const file of ["vips-node.js", "vips.wasm", "resvg.wasm"])
    await fs.copyFile(path.join(original, file), path.join(directory, file));
  const script = path.join(directory, "icon-tool.cjs");
  await fs.writeFile(script, singleFlightVips(source));
  // The supplied vips-node.js is CommonJS, including under this ESM repository.
  await fs.writeFile(
    path.join(directory, "package.json"),
    '{"type":"commonjs"}\n',
  );
  await promisify(execFile)(process.execPath, [
    script,
    "--input=build/icon.png",
    "--format=ico",
    "--out=build",
  ]);
}

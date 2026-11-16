import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createPrivateKey,
  createPublicKey,
  createHash,
  sign,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export async function prepareUpdatePackage({
  app,
  output,
  version,
  privateKeyFile,
  publicKey,
  target,
}) {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.ok(["darwin-arm64", "win32-x64"].includes(target));
  assert.equal(
    target,
    `${process.platform}-${process.arch}`,
    "Package on the target OS",
  );
  const key = createPrivateKey(await fs.readFile(privateKeyFile));
  assert.equal(key.asymmetricKeyType, "ed25519");
  assert.equal(
    createPublicKey(key).export({ format: "pem", type: "spki" }).toString(),
    createPublicKey(publicKey)
      .export({ format: "pem", type: "spki" })
      .toString(),
    "Signing key differs from the key embedded in the application",
  );
  app = await fs.realpath(app);
  output = path.resolve(output);
  assert.ok(
    !output.startsWith(app + path.sep),
    "Output must be outside application",
  );
  await fs.mkdir(output, { recursive: true });
  const name = `Passport-${version}-${target}-update.zip`;
  const zip = path.join(output, name);
  await fs.access(zip).then(
    () => {
      throw new Error("Never overwrite an existing update archive");
    },
    (error) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  if (process.platform === "darwin")
    execFileSync("/usr/bin/zip", ["-qry", zip, "."], {
      cwd: app,
      stdio: "pipe",
    });
  else {
    const { getPath7za } = await import("app-builder-lib/out/toolsets/7zip.js");
    execFileSync(await getPath7za(), ["a", "-tzip", "-mx=5", zip, "."], {
      cwd: app,
      stdio: "pipe",
      windowsHide: true,
    });
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(zip)) hash.update(chunk);
  const manifest = {
    format: "passport-update-v1",
    version,
    platforms: {
      [target]: {
        name,
        size: (await fs.stat(zip)).size,
        sha256: hash.digest("hex"),
      },
    },
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const metadata = `update-${target}.json`,
    signature = `update-${target}.sig`;
  await fs.writeFile(path.join(output, metadata), bytes, { flag: "wx" });
  await fs.writeFile(path.join(output, signature), sign(null, bytes, key), {
    flag: "wx",
  });
  return [name, metadata, signature];
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [app, output] = process.argv.slice(2);
  if (!app || !output)
    throw new Error(
      "Usage: node scripts/update-package.mjs <verified-app-directory> <output-directory>",
    );
  const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
  console.log(
    await prepareUpdatePackage({
      app,
      output,
      version: pkg.version,
      target: `${process.platform}-${process.arch}`,
      privateKeyFile: process.env.PASSPORT_UPDATE_PRIVATE_KEY_FILE,
      publicKey: process.env.PASSPORT_UPDATE_PUBLIC_KEY,
    }),
  );
}

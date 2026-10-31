import { spawnSync } from "node:child_process";
import fs from "node:fs";

const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const result = spawnSync(
  process.env.PASSPORT_CARGO || "cargo",
  ["test", "--locked", "--manifest-path", "native/helper/Cargo.toml"],
  {
    stdio: "inherit",
    env: { ...process.env, PASSPORT_APP_VERSION: version },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

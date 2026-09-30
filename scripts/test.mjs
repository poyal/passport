import { spawn } from "node:child_process";
import electron from "electron";
import checkTestEnvironment from "./check-test-environment.mjs";
import "./patch-ssh2.mjs";
await checkTestEnvironment();
const child = spawn(
  electron,
  ["node_modules/vitest/vitest.mjs", "run", ...process.argv.slice(2)],
  { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
);
child.on("exit", (code) => process.exit(code ?? 1));

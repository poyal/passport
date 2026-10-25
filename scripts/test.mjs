import { spawn } from "node:child_process";
import electron from "electron";
import checkTestEnvironment from "./check-test-environment.mjs";
import "./patch-ssh2.mjs";
await checkTestEnvironment();
const child = spawn(
  electron,
  ["node_modules/vitest/vitest.mjs", "run", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      // Direct `node scripts/test.mjs` runs need the same real Node path as npm
      // invocations when a PTY fixture starts a child CLI from Electron Vitest.
      npm_node_execpath: process.env.npm_node_execpath || process.execPath,
      ELECTRON_RUN_AS_NODE: "1",
    },
  },
);
child.on("exit", (code) => process.exit(code ?? 1));

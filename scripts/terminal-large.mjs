import { spawn } from "node:child_process";

const child = spawn(
  process.execPath,
  [
    "node_modules/@playwright/test/cli.js",
    "test",
    "tests/e2e/throughput.spec.ts",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit", env: { ...process.env, PASSPORT_TEXT_BENCH: "1" } },
);
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => process.exit(code ?? 1));

import { defineConfig } from "@playwright/test";
import { e2eMode } from "./scripts/e2e-mode.mjs";
const desktop = e2eMode() === "desktop";
export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./scripts/check-test-environment.mjs",
  workers: 1,
  fullyParallel: false,
  timeout: 45000,
  grep: desktop ? /@desktop/ : undefined,
  grepInvert: desktop ? undefined : /@desktop/,
  reporter: process.env.PASSPORT_TEST_REPORT
    ? [["list"], ["json", { outputFile: process.env.PASSPORT_TEST_REPORT }]]
    : "list",
  use: { trace: "retain-on-failure" },
  outputDir: "test-results",
});

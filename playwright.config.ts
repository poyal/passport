import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./scripts/check-test-environment.mjs",
  workers: 1,
  fullyParallel: false,
  timeout: 45000,
  reporter: "list",
  use: { trace: "retain-on-failure" },
  outputDir: "test-results",
});

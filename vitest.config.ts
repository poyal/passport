import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
    maxWorkers: process.platform === "win32" ? 1 : undefined,
  },
});

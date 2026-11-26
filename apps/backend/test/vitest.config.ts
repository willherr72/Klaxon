import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["test/**/*.test.ts"],
    maxWorkers: 2,
    testTimeout: 30_000,
  },
});

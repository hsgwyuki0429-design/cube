import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/debug/**", "node_modules/**"],
    testTimeout: 60000,
  },
});

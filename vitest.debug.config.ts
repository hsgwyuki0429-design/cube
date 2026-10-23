import { defineConfig } from "vitest/config";

// npx vitest run -c vitest.debug.config.ts : 画像を書き出すデバッグ用テスト
export default defineConfig({
  test: { include: ["tests/debug/**/*.debug.test.ts"], testTimeout: 600000 },
});

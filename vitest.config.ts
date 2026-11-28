import { defineConfig } from "vitest/config";

// テストは 2 つに分ける（CLAUDE.md の「検証」）:
//   npm test          = fast（重いもの以外。ふだん回す）
//   npm run test:slow = slow（合成画像を描いて認識から精密解析まで通す重いもの）
//   npm run test:all  = 全部（PR の前・CI）
// `npx vitest run tests/xxx.test.ts` はどちらに入っていても動く。
// 重いもの = CPU 2 つで 30 秒を超えるファイル（main f56748e で全体の 9 割）。
export const SLOW_TESTS = [
  "tests/arucoLive.test.ts",
  "tests/arucoCube.test.ts",
  "tests/startCheck.test.ts",
  "tests/offline.test.ts",
  "tests/gridRead.test.ts",
  "tests/parallelRefine.test.ts",
  "tests/refineGate.test.ts",
  "tests/earlyLead.test.ts",
  "tests/arucoTurn.test.ts",
  "tests/homeView.test.ts",
];

const EXCLUDE = ["tests/debug/**", "node_modules/**"];

export default defineConfig({
  test: {
    testTimeout: 60000,
    projects: [
      { extends: true, test: { name: "fast", include: ["tests/**/*.test.ts"], exclude: [...EXCLUDE, ...SLOW_TESTS] } },
      { extends: true, test: { name: "slow", include: SLOW_TESTS, exclude: EXCLUDE } },
    ],
  },
});

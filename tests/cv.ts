// テスト（Node）で OpenCV.js を読み込む: 本体と同じビルド（src/vendor/opencv/ の SIMD 版。Node 22 は SIMD に対応している）。
// 1 つのプロセスで 2 つの OpenCV.js を読み込まないこと（中でグローバルの Module を使うので、ぶつかって読み込みが終わらない）
import { createRequire } from "node:module";
import { type CV, initOpenCv } from "../src/vision/image";

let cached: Promise<CV> | null = null;

export function loadTestOpenCv(): Promise<CV> {
  cached ??= initOpenCv(createRequire(import.meta.url)("../src/vendor/opencv/opencv-simd.js"));
  return cached;
}

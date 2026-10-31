// テスト（Node）で OpenCV.js を読み込む: 本体と同じビルド（src/vendor/opencv/ の SIMD 版。Node 22 は SIMD に対応している）。
// ブラウザ（src/vision/opencv.ts）と同じく、ファイルの中身に module.exports を渡して実行する（このプロジェクトは "type": "module"
// なので、require すると厳格モードで読まれ、UMD の中のグローバルへの代入で落ちる）。
// 1 つのプロセスで 2 つの OpenCV.js を読み込まないこと（中でグローバルの Module を使うので、ぶつかって読み込みが終わらない）
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { type CV, initOpenCv } from "../src/vision/image";

let cached: Promise<CV> | null = null;

export function loadTestOpenCv(file = "opencv-simd.js"): Promise<CV> {
  cached ??= (() => {
    const path = fileURLToPath(new URL(`../src/vendor/opencv/${file}`, import.meta.url));
    const module = { exports: {} as CV };
    new Function("module", "exports", "require", "__filename", "__dirname", readFileSync(path, "utf8"))(module, module.exports, createRequire(path), path, fileURLToPath(new URL("../src/vendor/opencv/", import.meta.url)));
    return initOpenCv(module.exports);
  })();
  return cached;
}

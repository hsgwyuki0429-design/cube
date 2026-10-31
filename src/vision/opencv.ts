// ブラウザ（Worker）で OpenCV.js を読み込む。WebAssembly の SIMD に対応していれば SIMD 版、そうでなければ SIMD なしの版
// （どちらも src/vendor/opencv/ に置いた、ArUco の検出に要るものだけのビルド。検出の結果は同じ）。
// ファイルは UMD なので、module.exports を渡して実行し、その exports を受け取る（Worker 1 つに 1 回）
import plainUrl from "../vendor/opencv/opencv.js?url";
import simdUrl from "../vendor/opencv/opencv-simd.js?url";
import { type CV, initOpenCv } from "./image";

// SIMD の命令を 1 つ使う最小の wasm（wasm-feature-detect と同じもの）。読めれば SIMD に対応している
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

export const simdSupported = (): boolean => {
  try {
    return WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
};

export async function loadOpenCv(): Promise<CV> {
  const res = await fetch(simdSupported() ? simdUrl : plainUrl);
  if (!res.ok) throw new Error(`OpenCV.js を読み込めませんでした（${res.status}）`);
  const text = await res.text();
  const module = { exports: {} as CV };
  // UMD の「module.exports があれば代入する」の分岐を使う
  new Function("module", "exports", text)(module, module.exports);
  return initOpenCv(module.exports);
}

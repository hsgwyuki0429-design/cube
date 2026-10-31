# OpenCV.js（CubeVision 用に自分でビルドしたもの）

ArUco の検出に要る関数・クラスだけ（`scripts/opencv/cubevision_js.config.py`）を、OpenCV 4.10.0 と Emscripten 3.1.64 でビルドした。

- `opencv-simd.js`: WebAssembly の SIMD を使う（約 4.0MB）。対応するブラウザ（Chrome 91・Safari 16.4 以降など）ではこちら
- `opencv.js`: SIMD なし（約 2.6MB）。検出の結果は SIMD 版と同じ

どちらも wasm を中に持つ 1 ファイル（UMD）。ブラウザでは `src/vision/opencv.ts` が SIMD に対応しているかを調べて読み込み、
Node（テスト）では `tests/cv.ts` がそのまま require する。

作り直すとき: `EMSDK=…/emsdk OPENCV=…/opencv（4.10.0）bash scripts/opencv/build.sh 出力先` で、出力先の 2 つをここに置く。

以前の npm パッケージ（`@techstark/opencv-js`、約 13MB、SIMD なし）と比べ、合成の 8 場面（4 個の配置）で検出が
ライブの設定 36.5 → 18.7ms、精密解析の設定 37.1 → 23.0ms（Node）。

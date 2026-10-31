#!/usr/bin/env bash
# CubeVision 用の OpenCV.js（ArUco の検出に要るものだけ）を、SIMD あり・なしの 2 つビルドする。
#   EMSDK=…/emsdk OPENCV=…/opencv（4.10.0）bash scripts/opencv/build.sh 出力先
# 出力先に opencv-simd.js と opencv.js（どちらも wasm を中に持つ 1 ファイル）を書く。src/vendor/opencv/ に置いて使う（src/vision/image.ts）
set -euo pipefail
OUT=${1:?出力先}
: "${EMSDK:?emsdk の場所}"
: "${OPENCV:?OpenCV（4.10.0）のソースの場所}"
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
source "$EMSDK/emsdk_env.sh" >/dev/null
mkdir -p "$OUT"
# 要らないモジュールは作らない（objdetect は calib3d・features2d・flann を使う）
OPTS=(--cmake_option=-DBUILD_opencv_dnn=OFF --cmake_option=-DBUILD_opencv_photo=OFF --cmake_option=-DBUILD_opencv_video=OFF)
for variant in simd plain; do
  dir="$OUT/build-$variant"
  flags=()
  [ "$variant" = simd ] && flags+=(--simd)
  emcmake python3 "$OPENCV/platforms/js/build_js.py" "$dir" --build_wasm "${flags[@]}" --config "$HERE/cubevision_js.config.py" "${OPTS[@]}"
  name=opencv.js
  [ "$variant" = simd ] && name=opencv-simd.js
  cp "$dir/bin/opencv.js" "$OUT/$name"
done
ls -la "$OUT"/*.js

#!/bin/bash
# ライブの読み（liveReplay の材料）: 元の画質・REAL_FPS（0 = 全フレーム）。正解は REAL_REF（ソルブの範囲の精密解析）
BENCH=${BENCH:-/home/user/bench}; WT=${WT:-.}
cd $WT
n=$1; fps=$2; v=$(ls $BENCH/videos/${n}.*)
case $n in
  IMG_4970|IMG_4971) extra="REAL_END=solved";;
  IMG_4972) extra="REAL_START=scan REAL_SOLVE_FROM=11.4 REAL_END=solved";;
  IMG_5046) extra="REAL_START_FILE=$BENCH/start/IMG_5046.json REAL_FROM=10.10 REAL_SOLVE_FROM=12.88 REAL_END=solved";;
  IMG_5047) extra="REAL_START_FILE=$BENCH/start/IMG_5047.json REAL_FROM=10.33 REAL_SOLVE_FROM=14.62 REAL_END=solved";;
  IMG_5048) extra="REAL_START_FILE=$BENCH/start/IMG_5048.json REAL_FROM=14.35 REAL_SOLVE_FROM=21.04 REAL_END=solved";;
  IMG_5049) extra="REAL_START_FILE=$BENCH/start/IMG_5049.json REAL_FROM=4.21 REAL_SOLVE_FROM=12.79 REAL_END=solved";;
esac
ref=$BENCH/live/ref-${n}.json
if [ "$fps" = 0 ]; then rf=""; else rf="REAL_REFINE=0"; fi
f=""; [ "$fps" != 0 ] && f="REAL_FPS=$fps"
env $extra $rf $f REAL_VIDEO=$v REAL_REF=$ref REAL_READINGS=$BENCH/live/${n}-${fps}.json \
  npx vitest run -c vitest.debug.config.ts tests/debug/realVideo.debug.test.ts --silent=false > $BENCH/live/${n}-${fps}.log 2>&1

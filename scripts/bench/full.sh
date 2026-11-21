#!/bin/bash
# 原画質の動画全体の精密解析（正解づくり・Testvideo2 の始まりの状態）
BENCH=${BENCH:-/home/user/bench}; WT=${WT:-.}
cd $WT && mkdir -p $BENCH/bm $BENCH/dump
n=$1; v=$(ls $BENCH/videos/${n}.*)
extra=""
[ "$n" = IMG_4972 ] && extra="REAL_START=scan REAL_SOLVE_FROM=11.4"
env $extra REAL_VIDEO=$v REAL_NOLIVE=1 REAL_END=solved REAL_REF=$BENCH/bm/${n}.ref.json REAL_RREADINGS=$BENCH/dump/${n}_orig.read.json REAL_OBS=$BENCH/dump/${n}_orig.obs.json \
  npx vitest run -c vitest.debug.config.ts tests/debug/realVideo.debug.test.ts --silent=false > $BENCH/full_${n}.log 2>&1

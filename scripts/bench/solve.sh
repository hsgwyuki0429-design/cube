#!/bin/bash
# ソルブだけ（本体の条件）: REAL_NOLIVE=1 REAL_STILL=1、CLAUDE.md の REAL_FROM・REAL_SOLVE_FROM。読み・観測を書き出す
BENCH=${BENCH:-/home/user/bench}; WT=${WT:-.}
cd $WT && mkdir -p $BENCH/mat
n=$1; q=$2
if [ "$q" = orig ]; then v=$(ls $BENCH/videos/${n}.*); else v=$BENCH/enc/${n}_${q}.mp4; fi
case $n in
  IMG_4970|IMG_4971) extra="";;
  IMG_4972) extra="REAL_START=scan REAL_SOLVE_FROM=11.4";;
  IMG_5046) extra="REAL_START_FILE=$BENCH/start/IMG_5046.json REAL_FROM=10.10 REAL_SOLVE_FROM=12.88";;
  IMG_5047) extra="REAL_START_FILE=$BENCH/start/IMG_5047.json REAL_FROM=10.33 REAL_SOLVE_FROM=14.62";;
  IMG_5048) extra="REAL_START_FILE=$BENCH/start/IMG_5048.json REAL_FROM=14.35 REAL_SOLVE_FROM=21.04";;
  IMG_5049) extra="REAL_START_FILE=$BENCH/start/IMG_5049.json REAL_FROM=4.21 REAL_SOLVE_FROM=12.79";;
esac
env $extra REAL_VIDEO=$v REAL_NOLIVE=1 REAL_STILL=1 REAL_END=solved REAL_OBS_ONLY=1 REAL_RREADINGS=$BENCH/mat/${n}_${q}.read.json REAL_OBS=$BENCH/mat/${n}_${q}.obs.json \
  npx vitest run -c vitest.debug.config.ts tests/debug/realVideo.debug.test.ts --silent=false > $BENCH/solve_${n}_${q}.log 2>&1

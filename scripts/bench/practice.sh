#!/bin/bash
# 練習の数字（src/cube/solveStats.ts）の正確さを測る材料: 原画質 7 本と 5Mbps（画面全体 1280・ずらし 0・1・2）21 本の、本体の条件のソルブだけの
# 精密解析の結果（RefineResult。手ごとの向き・exact も入る）を $BENCH/practice/<名前>.ref.json に。材料（videos・dump・start・cropenc）は README の手順で
# 引数: res <動画> <orig|full_5000k_s0|…>（1 本）。まとめ: tests/debug/solveStatsBench.debug.test.ts
BENCH=${BENCH:-/home/user/bench}; WT=${WT:-.}
res() {
  n=$1; q=$2; nm=${n}_${q}; mkdir -p $BENCH/practice
  [ -f $BENCH/practice/$nm.ref.json ] && return
  if [ $q = orig ]; then v=$(ls $BENCH/videos/${n}.*); long=1280; else v=$BENCH/cropenc/$nm.mp4; long=$(python3 -c "import json;print(max(json.load(open('$v.crop.json'))['size']))"); fi
  case $n in
    IMG_4970|IMG_4971) extra="";;
    IMG_4972) extra="REAL_START=scan REAL_SOLVE_FROM=11.4";;
    IMG_5046) extra="REAL_START_FILE=$BENCH/start/IMG_5046.json REAL_FROM=10.10 REAL_SOLVE_FROM=12.88";;
    IMG_5047) extra="REAL_START_FILE=$BENCH/start/IMG_5047.json REAL_FROM=10.33 REAL_SOLVE_FROM=14.62";;
    IMG_5048) extra="REAL_START_FILE=$BENCH/start/IMG_5048.json REAL_FROM=14.35 REAL_SOLVE_FROM=21.04";;
    IMG_5049) extra="REAL_START_FILE=$BENCH/start/IMG_5049.json REAL_FROM=4.21 REAL_SOLVE_FROM=12.79";;
  esac
  (cd $WT && env $extra REAL_LONG=$long REAL_VIDEO=$v REAL_NAME=$nm REAL_NOLIVE=1 REAL_STILL=1 REAL_END=solved REAL_REF=$BENCH/practice/$nm.ref.json \
    npx vitest run -c vitest.debug.config.ts tests/debug/realVideo.debug.test.ts --silent=false > $BENCH/practice/$nm.log 2>&1)
}
"$@"

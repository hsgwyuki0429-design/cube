#!/bin/bash
# 切り出しの比べの材料: 動画 × full・crop1280・croporig × 5000・2500・1500k × ずらし 0・1・2 を圧縮し（crop.mjs）、ソルブだけの読み・観測を書き出す
# （solve.sh と同じ条件。切り出しは長辺をそのまま: REAL_LONG = 切り出しの大きさ）。BENCH（材料: dump/・start/・videos/）、WT（版の worktree）
BENCH=${BENCH:-/home/user/bench}; WT=${WT:-.}; S=$(cd $(dirname $0) && pwd)
mkdir -p $BENCH/cropenc $BENCH/cropmat
enc() { n=$1; m=$2; b=$3; k=$4; o=$BENCH/cropenc/${n}_${m}_${b}k_s${k}.mp4; [ -f $o.crop.json ] || node $S/crop.mjs $(ls $BENCH/videos/${n}.*) $o $m $b $k $BENCH/dump/${n}_orig.read.json > /dev/null; }
mat() {
  n=$1; m=$2; b=$3; k=$4; nm=${n}_${m}_${b}k_s${k}; v=$BENCH/cropenc/$nm.mp4
  [ -f $BENCH/cropmat/$nm.obs.json ] && return
  long=$(python3 -c "import json;print(max(json.load(open('$v.crop.json'))['size']))")
  case $n in
    IMG_4970|IMG_4971) extra="";;
    IMG_4972) extra="REAL_START=scan REAL_SOLVE_FROM=11.4";;
    IMG_5046) extra="REAL_START_FILE=$BENCH/start/IMG_5046.json REAL_FROM=10.10 REAL_SOLVE_FROM=12.88";;
    IMG_5047) extra="REAL_START_FILE=$BENCH/start/IMG_5047.json REAL_FROM=10.33 REAL_SOLVE_FROM=14.62";;
    IMG_5048) extra="REAL_START_FILE=$BENCH/start/IMG_5048.json REAL_FROM=14.35 REAL_SOLVE_FROM=21.04";;
    IMG_5049) extra="REAL_START_FILE=$BENCH/start/IMG_5049.json REAL_FROM=4.21 REAL_SOLVE_FROM=12.79";;
  esac
  (cd $WT && env $extra REAL_LONG=$long REAL_VIDEO=$v REAL_NOLIVE=1 REAL_STILL=1 REAL_END=solved REAL_OBS_ONLY=1 REAL_RREADINGS=$BENCH/cropmat/$nm.read.json REAL_OBS=$BENCH/cropmat/$nm.obs.json \
    npx vitest run -c vitest.debug.config.ts tests/debug/realVideo.debug.test.ts --silent=false > $BENCH/cropmat/$nm.log 2>&1)
}
"$@"

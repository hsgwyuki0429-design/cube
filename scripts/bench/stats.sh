#!/bin/bash
# 読める量の物差し（tests/debug/lib/recording.ts の readStats）を x264 の圧縮で測る: 実機の録画（設定画面の「録画を書き出す」）と並べるため。
# 本体の条件のソルブだけ（REAL_NOLIVE=1 REAL_STILL=1・インスペクションの間引き・今の解き直し）。範囲は 5000k の結果（REAL_REF）の
# 最初の手の回し始め〜最後の手の回し終わりを、ほかの画質にも使う（先に 5000k を回す）。
#   for n in IMG_4970 IMG_4971 IMG_4972 IMG_5046 IMG_5047 IMG_5048 IMG_5049; do echo $n 5000k; done | xargs -P 3 -n 2 scripts/bench/stats.sh
#   （続けて 2500k）→ RS_ROWS=$BENCH/stats/rows_5000k.jsonl … tests/debug/recordingStats.debug.test.ts
BENCH=${BENCH:-/home/user/bench}; WT=${WT:-.}
n=$1; q=$2; v=$BENCH/enc/${n}_${q}.mp4
mkdir -p $BENCH/stats
case $n in
  IMG_4970|IMG_4971) extra="";;
  IMG_4972) extra="REAL_START=scan REAL_SOLVE_FROM=11.4";;
  IMG_5046) extra="REAL_START_FILE=$BENCH/start/IMG_5046.json REAL_FROM=10.10 REAL_SOLVE_FROM=12.88";;
  IMG_5047) extra="REAL_START_FILE=$BENCH/start/IMG_5047.json REAL_FROM=10.33 REAL_SOLVE_FROM=14.62";;
  IMG_5048) extra="REAL_START_FILE=$BENCH/start/IMG_5048.json REAL_FROM=14.35 REAL_SOLVE_FROM=21.04";;
  IMG_5049) extra="REAL_START_FILE=$BENCH/start/IMG_5049.json REAL_FROM=4.21 REAL_SOLVE_FROM=12.79";;
esac
ref=""; [ "$q" != 5000k ] && ref="REAL_STATS_REF=$BENCH/stats/${n}_5000k.ref.json"
cd $WT && env $extra $ref REAL_VIDEO=$v REAL_NOLIVE=1 REAL_STILL=1 REAL_END=solved REAL_REF=$BENCH/stats/${n}_${q}.ref.json \
  REAL_STATS_OUT=$BENCH/stats/rows_${q}.jsonl REAL_STATS_LABEL="x264 ${q}" REAL_NAME=$n \
  npx vitest run -c vitest.debug.config.ts tests/debug/realVideo.debug.test.ts --silent=false > $BENCH/stats/${n}_${q}.log 2>&1

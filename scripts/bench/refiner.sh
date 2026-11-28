#!/bin/bash
# 版の worktree で: WT=<worktree> bash refiner.sh $BENCH/m1 → まとめ: RC_ROWS=$BENCH/m1/rows.jsonl RC_OUT=$BENCH/m1/rc.jsonl PB_TRUTH=$BENCH/truth PB_BM=$BENCH/bm npx vitest run -c vitest.debug.config.ts tests/debug/refinerCompare.debug.test.ts → python3 refinersum.py $BENCH/m1/rc.jsonl
# 精密解析 4: 本体の流れ（Refiner.result）を old・and で。1 本ずつ別のプロセスで、続けて（ほかの重い処理なし）
# 引数: 出力フォルダ。WT = 計測の版の worktree
BENCH=${BENCH:-/home/user/bench}; WT=${WT:-.}; OUT=$1; mkdir -p $OUT/rr $OUT/log
ver=$(cd $WT && git rev-parse --short HEAD); echo $ver > $OUT/ver
list() {
  for n in IMG_4970 IMG_4971 IMG_4972 IMG_5046 IMG_5047 IMG_5048 IMG_5049; do
    echo "$n orig"
    for b in 5000 2500 1500; do for k in 0 1 2; do echo "$n full_${b}k_s${k}"; done; done
  done
}
list | while read n q; do
  nm=${n}_${q}
  grep -q "\"name\":\"$nm\"" $OUT/rows.jsonl 2>/dev/null && continue
  if [ $q = orig ]; then v=$(ls $BENCH/videos/${n}.*); long=1280; else v=$BENCH/cropenc/$nm.mp4; long=$(python3 -c "import json;print(max(json.load(open('$v.crop.json'))['size']))"); fi
  case $n in
    IMG_4970|IMG_4971) extra="";;
    IMG_4972) extra="REAL_START=scan REAL_SOLVE_FROM=11.4";;
    IMG_5046) extra="REAL_START_FILE=$BENCH/start/IMG_5046.json REAL_FROM=10.10 REAL_SOLVE_FROM=12.88";;
    IMG_5047) extra="REAL_START_FILE=$BENCH/start/IMG_5047.json REAL_FROM=10.33 REAL_SOLVE_FROM=14.62";;
    IMG_5048) extra="REAL_START_FILE=$BENCH/start/IMG_5048.json REAL_FROM=14.35 REAL_SOLVE_FROM=21.04";;
    IMG_5049) extra="REAL_START_FILE=$BENCH/start/IMG_5049.json REAL_FROM=4.21 REAL_SOLVE_FROM=12.79";;
  esac
  stop=$(python3 -c "
import json
for l in open('$BENCH/rv/stops.jsonl'):
  r=json.loads(l)
  if r['name']=='$n' and str(r['fps'])=='15': print('%.3f,%.3f'%(r['at']/1000,r['until']/1000)); break
")
  [ -n "$stop" ] && extra="$extra REAL_METHODS_STOP=$stop"
  (cd $WT && env $extra REAL_LONG=$long REAL_VIDEO=$v REAL_NAME=$nm REAL_NOLIVE=1 REAL_STILL=1 REAL_END=solved REAL_PIECES=1 REAL_METHODS=old,and REAL_METHODS_OUT=$OUT/rows.jsonl \
    REAL_RREADINGS=$OUT/rr/$nm.read.json REAL_OBS=$OUT/rr/$nm.obs.json \
    npx vitest run -c vitest.debug.config.ts tests/debug/realVideo.debug.test.ts --silent=false > $OUT/log/$nm.log 2>&1)
  echo "$nm $(date +%T)" >> $OUT/progress
done
echo alldone >> $OUT/progress

#!/bin/bash
# piecesBench（and）を 1 本ずつ別のプロセスで。$1 = ラベル、$2 = PB_SOLVE。実機は正解の代わりに本体の結果（t<名前>）
BENCH=${BENCH:-/home/user/bench}; L=$1; S=$2; O=$BENCH/pb; WT=${WT:-.}
for f in $(ls $BENCH/m1/rr/*.read.json | sort); do
  n=$(basename $f .read.json)
  case $n in rec-*) T=$BENCH/realm/t${n#rec-20261127};; *) T=$BENCH/truth;; esac
  (cd $WT && PB_DIR=$BENCH/m1/rr PB_ONLY="^${n}\$" PB_TRUTH=$T PB_BM=$BENCH/bm PB_METHOD=and PB_SOLVE="$S" PB_OUT=$O/$L.jsonl PB_TIMELINE=$O/$L.tl.jsonl npx vitest run -c vitest.debug.config.ts tests/debug/piecesBench.debug.test.ts --silent=false > /dev/null 2>&1)
done
echo "$L done" >> $O/progress

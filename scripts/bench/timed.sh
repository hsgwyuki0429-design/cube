#!/bin/bash
# 方式ごと・1 本ずつ別のプロセスで（ほかの重い処理と並べない）。METHODS="old:版のworktree new:… and:… prop:…"
BENCH=${BENCH:-/home/user/bench}
out=$BENCH/timed/rows.jsonl; mkdir -p $BENCH/timed
for f in $(ls $BENCH/mat/*.read.json | sort); do
  n=$(basename $f .read.json)
  for mw in $METHODS; do
    m=${mw%%:*}; wt=${mw#*:}; ver=$(cd $wt && git rev-parse --short HEAD)
    (cd $wt && PB_DIR=$BENCH/mat PB_TRUTH=$BENCH/truth PB_BM=$BENCH/bm PB_ONLY="^${n}\$" PB_METHOD=$m PB_OUT=$BENCH/timed/tmp.jsonl npx vitest run -c vitest.debug.config.ts tests/debug/piecesBench.debug.test.ts --silent=false > $BENCH/timed/${n}_${m}.log 2>&1)
    tail -1 $BENCH/timed/tmp.jsonl | python3 -c "import sys,json; r=json.loads(sys.stdin.read()); r['ver']='$ver'; print(json.dumps(r))" >> $out
    rm -f $BENCH/timed/tmp.jsonl
  done
done

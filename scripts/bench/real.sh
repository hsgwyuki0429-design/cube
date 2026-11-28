#!/bin/bash
# 実機の録画（$BENCH/real/*.mp4）を書き出しの条件のまま old・and で。piecesBench の材料（rr）と正解の代わり（本体の結果: truth）も書き出す
# 実機の録画 2 本: 本体と同じ条件（書き出しから）で old・and。読み・観測・本体の結果（正解の代わり）を書き出す
BENCH=${BENCH:-/home/user/bench}; O=$BENCH/realm; WT=${WT:-.}
for f in $BENCH/real/*.mp4; do
  n=rec-$(echo $f | grep -o '2026112[0-9]*'); 
  (cd $WT && REAL_VIDEO=$f REAL_NAME=$n REAL_PIECES=and REAL_METHODS=old,and REAL_METHODS_OUT=$O/rows.jsonl REAL_RREADINGS=$O/rr/$n.read.json REAL_OBS=$O/rr/$n.obs.json REAL_APP_TRUTH=$O/truth/$n.ref.json \
    npx vitest run -c vitest.debug.config.ts tests/debug/realVideo.debug.test.ts --silent=false > $O/$n.log 2>&1)
done
echo realdone > $O/done

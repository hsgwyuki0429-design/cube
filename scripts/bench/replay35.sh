#!/bin/bash
# 35 通り（7 本 × 全フレーム・1 秒 20・15・10・6 枚）を liveReplay に通す。WT=版の worktree、引数は env に渡す（LIVE_PIECES='{"fixRun":0}' など）
BENCH=${BENCH:-/home/user/bench}; WT=${WT:-.}; cd $WT
sets=""; for n in IMG_4970 IMG_4971 IMG_4972 IMG_5046 IMG_5047 IMG_5048 IMG_5049; do for f in ${FPS:-0 20 15 10 6}; do sets="$sets,$n-$f.json:ref-$n.json"; done; done
env "$@" LIVE_DIR=$BENCH/live LIVE_SETS=${sets#,} LIVE_MOVES=1 LIVE_ANIM=1 npx vitest run -c vitest.debug.config.ts tests/debug/liveReplay.debug.test.ts --silent=false 2>&1

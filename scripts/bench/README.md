# 解き直しのベンチの材料（`docs/history.md` の「ベンチの材料 bench-1」）

実物 7 本 × 原画質・5Mbps・2.5Mbps・1.5Mbps = 28 本を、本体の条件（ソルブだけ・止まったフレームを飛ばす・インスペクションを間引く・ライブなし）で
`realVideo` に通した読み（`.read.json`）と観測（`.obs.json`）、正解（`buildTruth`）、原画質の動画全体の精密解析（`.ref.json`）、始まりの状態。
`BENCH`（既定 `/home/user/bench`）に置き、`WT`（材料を作る版の `git worktree`）で走らせる。

- 使うだけ: リリース `bench-1` の `bench-1.tar` を `BENCH` に展開し、
  `PB_DIR=$BENCH/mat PB_TRUTH=$BENCH/truth PB_BM=$BENCH/bm npx vitest run -c vitest.debug.config.ts tests/debug/piecesBench.debug.test.ts --silent=false`
- 作り直す: `encode.sh`（動画は GitHub のリリース test-videos-1・Testvideo2 から `$BENCH/videos` へ）→ `full.sh <動画>`（7 本）→ `startfiles.mjs`
  → `solve.sh <動画> <orig|5000k|2500k|1500k>`（28 本）→ `buildTruth`（`BT_DIR=$BENCH/dump BT_REF=$BENCH/bm BT_OUT=$BENCH/truth`）
- **x264 は既定（複数スレッド）だと同じコマンドでも毎回違う動画になる**（`encode.sh` は `-threads 1` で毎回同じにする）。bench-1 の圧縮した動画は
  `-threads 1` を付ける前に作ったもの: 作り直すときはリリースの動画を使う
- 時間を測るとき: `timed.sh`（1 本ずつ別のプロセスで、ほかの重い処理と並べない）→ `summarize.py rows.jsonl`

# 解き直しのベンチの材料（`docs/history.md` の「ベンチの材料 bench-2」）

実物 7 本 × 原画質・5Mbps・2.5Mbps・1.5Mbps = 28 本を、本体の条件（ソルブだけ・止まったフレームを飛ばす・インスペクションを間引く・ライブなし）で
`realVideo` に通した読み（`.read.json`）と観測（`.obs.json`）、正解（`buildTruth`）、原画質の動画全体の精密解析（`.ref.json`）、始まりの状態。
`BENCH`（既定 `/home/user/bench`）に置き、`WT`（材料を作る版の `git worktree`）で走らせる。材料はリポジトリにもリリースにも入れない
（作り直す。作り直したものが同じかは `docs/history.md` の sha256 で確かめる）。

1. 動画: GitHub のリリース `test-videos-1`（`IMG_4970`〜`4972.MOV`）・`Testvideo2`（`IMG_5046`〜`5049.mov`）を `$BENCH/videos` へ
2. `encode.sh`: 5・2.5・1.5Mbps に圧縮（**`-threads 1`**: x264 は既定の複数スレッドだと同じコマンドでも毎回違う動画になり、低い画質の 1 本は
   それだけで「完成」と「届かない」が入れ替わる。`-threads 1` なら毎回同じ）
3. `full.sh <動画>`（7 本）: 原画質の動画全体の精密解析 → `$BENCH/bm`・`$BENCH/dump`
4. `node --experimental-strip-types startfiles.mjs IMG_5046 IMG_5047 IMG_5048 IMG_5049`: Testvideo2 の始まりの状態 → `$BENCH/start`
5. `solve.sh <動画> <orig|5000k|2500k|1500k>`（28 本）: ソルブだけの読み・観測 → `$BENCH/mat`
6. 正解: `BT_DIR=$BENCH/dump BT_REF=$BENCH/bm BT_OUT=$BENCH/truth npx vitest run -c vitest.debug.config.ts tests/debug/buildTruth.debug.test.ts --silent=false`
7. 確かめる: `cd $BENCH && sha256sum enc/*.mp4 mat/*.json truth/*.json start/*.json` を `docs/history.md` の表と比べる

使う: `PB_DIR=$BENCH/mat PB_TRUTH=$BENCH/truth PB_BM=$BENCH/bm npx vitest run -c vitest.debug.config.ts tests/debug/piecesBench.debug.test.ts --silent=false`。
時間を測るときは `timed.sh`（`METHODS="old:版の worktree new:… and:…"`、1 本ずつ別のプロセスで、ほかの重い処理と並べない）→ `python3 summarize.py $BENCH/timed/rows.jsonl`

## 録画の切り出しの比べ（精密解析 1b）

- `crop.mjs`: 動画を「画面全体 1280」「1280 から切り出し」「元の解像度から切り出し」で圧縮する（`-threads 1`、開始をずらす数を選べる。
  切り出しの位置は `<出力>.crop.json`）。切り出す範囲は `$BENCH/dump/<動画>_orig.read.json`（`full.sh` の読み）の面の外枠から
- `crop-build.sh enc|mat <動画> <full|crop1280|croporig> <kbps> <ずらし>`: 圧縮（`$BENCH/cropenc`）と、ソルブだけの材料（`$BENCH/cropmat`。
  長辺は切り出しの大きさのまま）。7 本 × 3 × 3 × 3 = 189 本は `xargs -P` で並べてよい（材料づくりは時間を測らない）
- 解き直しは `piecesBench`（`PB_DIR=$BENCH/cropmat`）を 1 本ずつ別のプロセスで → `rows.jsonl` → `python3 cropsum.py`（`BENCH` を読む）
- 確かめる: `cd $BENCH && sha256sum -c` に `crop-1b.sha256` を渡す（1a の元の解像度の材料 `native/` も入っている）

## 実機の録画と比べる読める量（精密解析 1c の前に）

- `stats.sh <動画> <5000k|2500k>`: 本体の条件のソルブだけで、読める量の物差し（1 フレームに読めたマス・ピース、確かな読みのない区間、fps・抜け）を
  `$BENCH/stats/rows_<画質>.jsonl` に 1 行ずつ。5000k を先に（その結果の範囲を 2500k にも使う）。まとめは `RS_ROWS=… tests/debug/recordingStats.debug.test.ts`
- 実機の録画（設定画面の「録画を書き出す」）は `REAL_VIDEO=書き出したファイル REAL_STATS_OUT=… REAL_STATS_LABEL=実機` で同じ行を足す（`docs/history.md` の
  「実機の録画を書き出して比べる道具」）

## 島に分けて解く案の上限（精密解析 3 の前）

- 材料: 上の bench-2（`mat/` の原画質）と、切り出しの比べの「画面全体 1280」（`crop-build.sh enc|mat <動画> full <kbps> <ずらし>`、7 本 × 3 × 3 = 63 本）。
  `crop-1b.sha256` の cropenc・cropmat の full の行で確かめる
- 1 本ずつ別のプロセスで: `IB_DIR=<mat か cropmat> IB_ONLY="^<名前>$" IB_TRUTH=$BENCH/truth IB_BM=$BENCH/bm IB_ORIG=$BENCH/mat IB_OUT=rows.jsonl
  npx vitest run -c vitest.debug.config.ts tests/debug/islandBound.debug.test.ts --silent=false`
- 今の方式だけ: 同じ材料を `piecesBench` の `PB_METHOD=old PB_OUT=old.jsonl` で 1 本ずつ
- まとめ: `python3 islandsum.py rows.jsonl`（本ごと・ビットレートごと・隙間）、`python3 islandfb.py rows.jsonl`（今の方式に戻った本だけ）、
  `python3 islandold.py rows.jsonl old.jsonl`（今の方式だけとの比べ）

## ライブの物差しの 35 通り（`liveReplay`）

- 上の 1・3・4（動画・`full.sh`・`startfiles.mjs`）のあと、`live.sh <動画> <fps>`（fps 0 = 全フレーム。先に 0 を: その精密解析が
  `$BENCH/live/ref-<動画>.json` になり、ほかの fps はそれを読む）を 7 本 × 0・6・10・15・20（タイマーの `timerEdges` には 30 も）→ `$BENCH/live`
- `replay35.sh`（`WT=版の worktree`）。直す前の数は `docs/history.md` の「ソルブ中のライブの状態を表の AND で推定する」の「推定（既定）」と同じになる
- `timerEdges` は `TE_DIR` に `read-<番号>-<fps>.json`・`ref-<番号>.json` の名前で置く（`$BENCH/live` のファイルへのリンクでよい）

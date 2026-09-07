# CubeVision — フェーズ0 技術検証ハーネス

カメラ1つで任意の3x3ルービックキューブの回転をリアルタイム追跡できるかを **測定するための** ハーネス。
プロダクトではない。見た目は問わない。数値が出ることが全て。

判定基準と背景は `docs/cube-vision-plan.md` §6、実装規約は `CLAUDE.md`。
現時点で分かっていることは `docs/phase0-findings.md`。
キューブ姿勢追跡（Phase 0.5）は `docs/cube-tracking.md`。

## 使い方

```bash
npm install
npm run dev        # localhost で開く
npm run dev:lan    # スマホ実機用（LAN 公開 + 自己署名HTTPS）
```

`getUserMedia` は HTTPS または localhost でしか動かない。スマホから開くときは
`npm run dev:lan` が出す `https://<LANのIP>:5173/` を使う。自己署名証明書なので
初回はブラウザの警告を承認する必要がある。

### 検証の手順

1. **カメラ開始** — 解像度・要求fps・折衝fps・実測fps が出る。要求値と実測値は違うので実測を見る。
2. **ROI を合わせる** — 四隅の丸をドラッグして面に重ねる。丸の番号 0→1→2→3 が
   facelet の (0,0)→(0,2)→(2,2)→(2,0) に対応する。向きが合わないときは `rot` を回す。
   各 ROI にどの空間面が映っているかを選ぶ（カメラは固定なので実行中に変わらない）。
   ROI は 3 枚まで足せる（→ findings の「可視面の枚数」）。
2b. **自動追跡にする（任意）** — 「キューブ姿勢追跡」パネルで ROI 供給元を
   「自動追跡」に切り替え、ROI を合わせた状態で [現在の ROI から初期化] を押す。
   以後はキューブやスマホが多少動いてもグリッドが面に貼り付いたまま追従する。
   追えなくなったら誤魔化さず LOST にして再取得を求める。詳細は `docs/cube-tracking.md`。
3. **キャリブレーション** — 完成状態のキューブの U/R/F/D/L/B を順に同じ ROI に見せる。
   6色間の最小距離が出るので、判別困難な配色ならここで警告が出る。
4. **色分類精度を計測** — 完成キューブを映したまま数十秒。目標 98%。
5. **追跡開始** — 閾値は全て実行時に変更できる。プリセットから一括適用もできる。
6. **計測モード** — 目標TPSを選び、スクランブル生成 → 適用 → 一致検証 → 最初の1手で
   自動計測開始 → 完成検出で停止。結果は TPS 別に集計される。
7. **Go / No-Go 判定** — パネル最上部。未計測が1つでもあれば PENDING のまま。

### 録画とリプレイ

改善を定量評価するための土台であって、おまけではない。

- **録画開始** → 各フレームの Lab / 分類ラベル / 信頼度 / fps / 処理時間 を記録し、JSON で落とせる
- **リプレイ実行** → カメラなしで追跡エンジンだけを再実行する
- **プリセット比較** → 同じ録画に全プリセットを流して完走率を横並びで見る

## コマンド

| コマンド | 内容 |
|---|---|
| `npm test` | 全ユニットテスト + `fixtures/` の回帰テスト（完走率・誤検出を表示） |
| `npm run sweep` | 閾値プリセットを全 fixture で横並び比較 |
| `npm run fixtures` | `fixtures/` の合成録画を再生成 |
| `npm run video` | ブラウザ統合テスト用の合成キューブ動画（Y4M）を生成 |
| `npm run typecheck` | 型チェック |
| `npm run build` | 本番ビルド |

## 構成

```
src/core/cube.ts        キューブ状態機械。カメラも DOM も知らない純粋モジュール
src/core/tracker.ts     追跡エンジン。同上（リプレイと回帰テストが同じコードを通る）
src/vision/camera.ts    getUserMedia + requestVideoFrameCallback + fps 実測
src/vision/homography.ts 4隅→単位正方形の射影変換
src/vision/roi.ts       ROI 定義・セルのサンプリング点生成
src/vision/color.ts     sRGB→CIELab、キャリブレーション、最近傍分類、EMA 適応
src/vision/worker.ts    認識 Worker（OffscreenCanvas でピクセル→Lab）
src/dev/recorder.ts     録画
src/dev/replay.ts       リプレイ・閾値スイープ
src/dev/synth.ts        合成録画生成（回帰テスト用）
src/dev/solves.ts       計測結果の集計と Go/No-Go 判定
src/tracking/geometry.ts     ホモグラフィ推定・RANSAC・四角形の妥当性判定
src/tracking/opticalFlow.ts  ピラミッド型 Lucas-Kanade
src/tracking/hexModel.ts     角から見たキューブの六角形モデル・グリッドロック比
src/tracking/cubeTracker.ts  姿勢追跡の状態機械（純粋モジュール）
src/dev/cubeRender.ts        合成キューブ映像（追跡の数値評価用）
src/dev/trackingEval.ts      追跡の数値評価ハーネス
src/ui/                 素の DOM。オーバーレイと設定パネル
```

依存は `typescript / vite / vitest / @vitejs/plugin-basic-ssl / @types/node` のみ。
React も OpenCV.js も ML も使っていない。姿勢追跡（Lucas-Kanade + ホモグラフィ推定）も
自前実装で、Worker バンドルは 27KB に収まっている（→ `docs/cube-tracking.md` §1）。

## 注意

`fixtures/` は現在すべて **合成データ**（`synthetic: true`）。アルゴリズムの回帰検出には
使えるが、**Go/No-Go の根拠にはならない。** 実機録画を `fixtures/` に置いてから判断すること。

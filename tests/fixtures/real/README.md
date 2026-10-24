# 実写のテスト画像

`dw-*.rgb.z` は [dwalton76/rubiks-cube-tracker](https://github.com/dwalton76/rubiks-cube-tracker) の
`test-data/3x3x3-random-01`（MIT License, Copyright (c) 2019 Daniel Walton）の写真を、キューブの周りで切り抜いて縮小し、
RGB の生データを zlib で圧縮したもの（288×272）。`dw-truth.json` は同じリポジトリの正解（各ステッカーの RGB、URFDLB 順）。

ロボットに固定したキューブを正面から撮った写真で、カメラの色合いのせいで黄色がクリーム色（白とほぼ同じ）、
オレンジがサーモンピンクに写っている。実物の色の難しさを試すのに使う。

// 追跡エンジンの入出力型。カメラにも DOM にも依存しない。

export type Lab = [number, number, number];

// 1つの面の観測。slot はカメラフレームの面番号（F=2 がカメラ正面、U=0 が上、R=1 が右…）。
// cost[cell * 6 + color] = そのセルが color だと仮定したときのペナルティ（0 = 矛盾なし）。
// 情報のないセル（手で隠れた・読めない）は全色 0。
export interface FaceObservation {
  slot: number;
  cost: Float32Array;
  labels: Int8Array; // 9 セルの最尤色（-1 = 不明）
  alts?: Float32Array[]; // 窓の位置をずらした読みのコスト（どれか 1 つが正しい。デコーダは最も合うものを使う）
  // マスごとに違う ArUco ステッカー: 9 セルで読んだステッカー（揃った状態での facelet 番号、-1 = 不明）と、
  // 色は合うのに別のステッカーだったときのペナルティ。同じ色のどのステッカーかまで照らす（src/cube/stickers.ts）
  ids?: Int16Array;
  idCost?: Float32Array;
}

export interface Observation {
  t: number; // この見え方が始まった時刻（ms）
  tPrevEnd: number; // 前の観測が最後に見えていた時刻（手はこの間に起きた）
  faces: FaceObservation[];
}

export interface DecodedMove {
  move: number; // キューブ固定フレームの手（0..17）
  t0?: number; // 回し始めの推定時刻（ms）。この手の前の見え方が最後に確認できた時刻以降
  t: number; // 回し終わりの推定時刻（ms）。回した後の見え方が安定して見え始めた時刻
  orient: number; // その手のときのキューブの姿勢（持ち方基準の表記に使う）
  inferred?: boolean; // 直接は見えず、後から辻褄合わせで推定した手
}

export type TrackStatus = "tracking" | "uncertain" | "lost";

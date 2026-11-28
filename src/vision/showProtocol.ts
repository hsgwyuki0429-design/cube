// 止めた後の画面（src/ui/StoppedScreen.tsx）に見せる、精密解析の Worker からの知らせの形。精密解析がどのみち出しているもの
// （処理したフレームの認識の結果・解き直しの仮説）を 1 秒 10 回まで本体に送る。画像は送らない。
// 送り先は BroadcastChannel（RefineInput.show の channel。Worker と本体のメッセージの受け口 visionClient.ts を触らないため）

// 送り先: BroadcastChannel の名前と、この解析の番号（前の解析の遅れた知らせを捨てる）
export interface ShowRef {
  channel: string;
  token: number;
}

// 録画を読む段: いちばん新しく処理したフレームの、カメラの面（0 上 / 1 右 / 2 正面 / 3 下 / 4 左）× 9 マスに直接読めた ID（-1 = 読めない）
export interface ReadShow {
  kind: "read";
  token: number;
  t: number; // そのフレームの撮影時刻（ms）
  ids: number[]; // 45 = 面 5 × 9 マス（layout.ts の面の並び。マスは行 × 3 + 列）
  cells: number; // そのフレームで直接読めたマスの数
  // 前の知らせから処理したフレームの、直接読めたマスの合計と枚数・その時刻の範囲（本体が区間ごとの濃さにまとめる）
  sum: number;
  n: number;
  t0: number;
  t1: number;
  // 読み終えたフレーム（解析の範囲の録画のうち、処理か飛ばすかを決め終えたもの）と、受け取った録画のフレームの数
  done: number;
  total: number;
}

// 前向き・後ろ向きのどちらかの探索の様子
export interface DirShow {
  t: number | null; // 読みと合っている所まで進んだ時刻（見失った区間が続けば、その始まりで止まる）。まだ進んでいなければ null
  hyps: number; // いま持っている仮説の数
  near: number; // 一番よい仮説とコストの差が NEAR_COST 以内の仮説（有力な枝）
  dropped: number; // ここまでに落とした仮説（次の観測で子が 1 つも残らなかったもの）の数
  steps: number; // 進めた観測の数
}

// 解き直しの段: 1 回目（first）・つながらなかったときの深い 2 回目（deep）・止めた時刻で打ち切るときの解き直し（stop）
export type SearchStage = "first" | "deep" | "stop";

export interface SearchShow {
  kind: "search";
  token: number;
  stage: SearchStage;
  f: DirShow;
  b: DirShow;
  meetT: number | null; // つないだ所（その観測の時刻。見つかっていなければ null）
  step?: "bridge" | "finish"; // 前後がつながらず、隠れた区間の橋渡し・前向きを補う所に進んだ
}

export type ShowMessage = ReadShow | SearchShow;

export const SHOW_EVERY_MS = 100; // 1 秒 10 回まで
export const NEAR_COST = 3; // 有力な枝: 1 手（1）+ マスの矛盾 1 つ（1.5）ほど

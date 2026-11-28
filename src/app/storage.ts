// ソルブ履歴の保存（localStorage）
import { moveIndex } from "../cube/model";

export interface SolveMove {
  m: string; // キューブ固定（センター色基準）の表記
  r: string; // 持ち方基準の表記
  t: number; // 計測開始から、この手を回し終わるまでの ms
  s?: number; // 計測開始から、この手を回し始めるまでの ms
  o?: number; // この手を回したときにカメラから見えていたキューブの向き（キューブ固定 → カメラ。ORIENTATIONS の番号）
  inferred?: boolean;
}

export interface Solve {
  id: string;
  date: number;
  scramble: string;
  timeMs: number;
  penalty: "" | "+2" | "DNF";
  moves: SolveMove[];
  tps: number;
  splits?: { name: string; t: number; moves: number }[];
  // カメラから見えたキューブの連続的な向き（計測開始からの ms と四元数 x y z w。1 秒 10 回ほど）。記録の詳しい画面の 3D で使う
  poses?: number[][];
  tracked: boolean; // カメラ追跡で計測したか（手動停止なら false）
  // 録画の精密解析: pending = 解析中（表示は速報値）/ done = 全フレームから確定 / failed = 解析できず速報値のまま
  // partial = 解析で手順は確定したが、タイムの端の一部はリアルタイムの値（端の手が写っていない・手動で止めた）
  analysis?: "pending" | "done" | "partial" | "failed";
  // partial のとき、時刻をフレームから決められずリアルタイムの値を使った端（「時刻が分からない」）。端の手がどの手か決まらない
  // （「手が分からない」）は moves の inferred で、時刻とは別: 端の手が inferred でも層の動きが見えていれば時刻は確か
  liveEdges?: ("start" | "end")[];
  provisionalMs?: number; // 解析前の速報値
  video?: boolean; // 動画ファイル（スロー撮影など）を読み込んで解析した記録
  // GAN タイマー（Bluetooth）で計った: ms = タイマーのタイム（timeMs と同じ）・visionMs = 精密解析のタイム（最初の手の回し始め〜最後の手の
  // 回し終わり）・lead = 手を離してから回し始めるまで・tail = 回し終えてから手を置くまで（解析で両端が決まったときだけ）
  pad?: { ms: number; visionMs?: number; lead?: number; tail?: number };
  refineMethod?: string; // 精密解析の解き直しの方法（pieces = ピースの時刻表。試験中の比較用）
  // 撮ったときのステッカーのマーカーの配置（src/aruco/design.ts の STICKERS。URL の ?stickers=）。ないのは配置を残す前の記録で quad-half
  stickers?: "quad-half" | "standard";
  // リアルタイムのタイマーが始めた・止めた理由（src/app/startDetect.ts・stopDetect.ts）。調べるとき用で、画面には出さない
  edges?: { start?: StartWhy; stop?: StopWhy };
  // ライブが読んだマス: タイマーの開始〜停止の間に、ライブのフレームの見え方でマーカーを直接読めたマスの合計と、処理したフレームの数
  // （src/app/liveReads.ts。止めた後の結果カード。2026-11-28 より前の記録にはない）
  liveReads?: { cells: number; frames: number };
  settleMs?: number; // 止めてから精密解析で確定（一部推定・速報値も）するまで（ms。止めた後の結果カード）
}

// 開始: ids = 見え方が ID でスクランブルの状態から変わり、層が動いたのを見た / pad = GAN タイマー。
// frames = 変わって見えたフレームの数・miss = 1 つの面で合わなかった最大の枚数・move = 層が動いたのを見た手（解析の始まりからの番号）・
// at = 開始の時刻をどこから決めたか（first = 最初の手の動き出し / exact = 後の手の動き出し / t0 = 最初の手の前の読みが最後に見えた時刻 /
// bound = 変わり始めたフレームから遡れる限り）・lag = 決めた時刻 − 開始の時刻（ms）
export interface StartWhy {
  how: "ids" | "pad";
  frames?: number;
  miss?: number;
  move?: number;
  at?: "first" | "exact" | "t0" | "bound";
  lag?: number;
}

// 停止: ids = 揃いの見え方が続いた / tracked = 追跡の揃い（見え方で照らした）/ manual / pad。
// home = 揃いの場所にいたステッカーの数（接し方でつながる面のまとまり）・faces = その面の数・frames = 揃いが続いたフレームの数・
// hold = 揃いが見え始めてから止めると決めるまで（ms）・cut = 精密解析で、止めた後の手として手順から外した手の数（まとめる前。
// src/track/stopCut.ts）・cutBy = 外し方（prefix = 手順の途中の揃いで切った / decode = 止めると決めたフレームまでで解き直した）・
// endApprox = 打ち切った最後の手の回し終わりをフレームから決められず、回し始めと止めた時刻の真ん中にした（近似。確定のまま）・
// approxMs = その間の長さ（ms。誤差はこの半分まで）
export interface StopWhy {
  how: "ids" | "tracked" | "manual" | "pad";
  home?: number;
  faces?: number;
  frames?: number;
  hold?: number;
  cut?: number;
  cutBy?: "prefix" | "decode";
  endApprox?: boolean;
  approxMs?: number;
}

const SOLVES_KEY = "cubevision.solves.v1";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// 解析中に閉じたソルブは録画が残っていないので、速報値のまま
export const loadSolves = () => read<Solve[]>(SOLVES_KEY, []).map((s) => (s.analysis === "pending" ? { ...s, analysis: "failed" as const } : s));
export const saveSolves = (s: Solve[]) => write(SOLVES_KEY, s);

// 自分のソルブの手順（解析で確定したもの・見えていた手だけ）。追跡の「手順の知識」に加える（その人の癖のある手順を覚える）
export function personalSequences(solves: Solve[], n = 30): number[][] {
  const out: number[][] = [];
  for (const s of solves) {
    if (s.analysis !== "done" || !s.moves.length) continue;
    const seq: number[] = [];
    for (const m of s.moves) {
      if (m.inferred) {
        if (seq.length >= 4) out.push(seq.splice(0));
        else seq.length = 0;
        continue;
      }
      try {
        seq.push(moveIndex(m.m));
      } catch {
        seq.length = 0;
      }
    }
    if (seq.length >= 4) out.push(seq);
    if (out.length >= n) break;
  }
  return out;
}

export const effectiveTime = (s: Solve) => (s.penalty === "DNF" ? Infinity : s.timeMs + (s.penalty === "+2" ? 2000 : 0));

// WCA 方式の平均（最良と最悪を除く）
export function averageOf(solves: Solve[], n: number): number | null {
  if (solves.length < n) return null;
  const times = solves.slice(0, n).map(effectiveTime).sort((a, b) => a - b);
  const trim = n >= 5 ? Math.ceil(n * 0.05) : 0;
  const kept = times.slice(trim, n - trim);
  if (kept.some((t) => !Number.isFinite(t))) return Infinity;
  return kept.reduce((s, t) => s + t, 0) / kept.length;
}

export function formatTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (!Number.isFinite(ms)) return "DNF";
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return m ? `${m}:${s.toFixed(2).padStart(5, "0")}` : s.toFixed(2);
}

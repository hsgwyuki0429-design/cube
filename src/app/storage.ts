// キャリブレーション（キューブの6色）とソルブ履歴の保存（localStorage）
import { moveIndex } from "../cube/model";
import type { Lab } from "../vision/color";

export interface Calibration {
  refs: Lab[]; // 面 U R F D L B ごとの代表色
  names: string[]; // 面ごとの色名（W/Y/R/O/B/G）
  scheme: "standard" | "other";
  savedAt: number;
}

export interface SolveMove {
  m: string; // キューブ固定（センター色基準）の表記
  r: string; // 持ち方基準の表記
  t: number; // 計測開始から、この手を回し終わるまでの ms
  s?: number; // 計測開始から、この手を回し始めるまでの ms
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
  tracked: boolean; // カメラ追跡で計測したか（手動停止なら false）
  // 録画の精密解析: pending = 解析中（表示は速報値）/ done = 全フレームから確定 / failed = 解析できず速報値のまま
  analysis?: "pending" | "done" | "failed";
  provisionalMs?: number; // 解析前の速報値
}

const CAL_KEY = "cubevision.calibration.v1";
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

export const loadCalibration = () => read<Calibration | null>(CAL_KEY, null);
export const saveCalibration = (c: Calibration) => write(CAL_KEY, c);
export const clearCalibration = () => {
  try {
    localStorage.removeItem(CAL_KEY);
  } catch {
    // 無視
  }
};

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

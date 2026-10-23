// cubing.js のソルバー・スクランブル生成のラッパー。
// ブラウザでは専用 Worker（solver.worker.ts）で、Node（テスト）では直接呼ぶ。
import type { KPatternData } from "cubing/kpuzzle";
import { type CubeState, MOVE_NAMES, invertMoves, parseMoves } from "./model";
import { loadKPuzzle, stateToPattern } from "./pattern";

const normalize = (alg: string) =>
  alg
    .replace(/2'/g, "2")
    .replace(/\s+/g, " ")
    .trim();

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (s: string) => void; reject: (e: Error) => void }>();

function useWorker(): boolean {
  return typeof window !== "undefined" && typeof Worker !== "undefined";
}

function call(msg: { type: "solve"; data: KPatternData } | { type: "scramble" }): Promise<string> {
  if (!worker) {
    worker = new Worker(new URL("./solver.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const { id, result, error } = e.data as { id: number; result?: string; error?: string };
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error !== undefined) p.reject(new Error(error));
      else p.resolve(result!);
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || "solver worker error"));
      pending.clear();
      worker = null;
    };
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ id, ...msg });
  });
}

async function solvePatternData(data: KPatternData): Promise<string> {
  if (useWorker()) return call({ type: "solve", data });
  const { experimentalSolve3x3x3IgnoringCenters } = await import("cubing/search");
  const { KPattern } = await import("cubing/kpuzzle");
  return (await experimentalSolve3x3x3IgnoringCenters(new KPattern(await loadKPuzzle(), data))).toString();
}

// state を完成させる手順（キューブ固定フレームの18手）
export async function solveState(state: CubeState): Promise<number[]> {
  const pattern = await stateToPattern(state);
  return parseMoves(normalize(await solvePatternData(pattern.patternData)));
}

// from の状態から to の状態にする手順
export async function solveBetween(from: CubeState, to: CubeState): Promise<number[]> {
  const kpuzzle = await loadKPuzzle();
  const fromT = (await stateToPattern(from)).experimentalToTransformation()!;
  const toT = (await stateToPattern(to)).experimentalToTransformation()!;
  // 求める X は from·X = to。P = solved·to⁻¹·from を解くと P·X = solved
  const p = kpuzzle.defaultPattern().applyTransformation(toT.invert()).applyTransformation(fromT);
  return parseMoves(normalize(await solvePatternData(p.patternData)));
}

// 完成状態から state を作る手順（3Dビューのセットアップ用）
export async function setupMovesFor(state: CubeState): Promise<number[]> {
  return invertMoves(await solveState(state));
}

// WCA のランダム状態スクランブル
export async function randomScramble(): Promise<number[]> {
  if (useWorker()) return parseMoves(normalize(await call({ type: "scramble" })));
  const { randomScrambleForEvent } = await import("cubing/scramble");
  return parseMoves(normalize((await randomScrambleForEvent("333")).toString()));
}

export const movesText = (moves: number[]) => moves.map((m) => MOVE_NAMES[m]).join(" ");

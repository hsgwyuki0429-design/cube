// cubing.js のソルバー・スクランブル生成のラッパー。重いので動的 import。
import { Alg } from "cubing/alg";
import { type CubeState, MOVE_NAMES, parseMoves } from "./model";
import { loadKPuzzle, stateToPattern } from "./pattern";

const normalize = (alg: string) =>
  alg
    .replace(/2'/g, "2")
    .replace(/\s+/g, " ")
    .trim();

// state を完成させる手順（キューブ固定フレームの18手で表したもの）
export async function solveState(state: CubeState): Promise<number[]> {
  const { experimentalSolve3x3x3IgnoringCenters } = await import("cubing/search");
  const pattern = await stateToPattern(state);
  const solution = await experimentalSolve3x3x3IgnoringCenters(pattern);
  return parseMoves(normalize(solution.toString()));
}

// from の状態から to の状態にする手順
export async function solveBetween(from: CubeState, to: CubeState): Promise<number[]> {
  const { experimentalSolve3x3x3IgnoringCenters } = await import("cubing/search");
  const kpuzzle = await loadKPuzzle();
  const fromT = (await stateToPattern(from)).experimentalToTransformation()!;
  const toT = (await stateToPattern(to)).experimentalToTransformation()!;
  // 求める X は from·X = to。P = solved·to⁻¹·from を解くと P·X = solved
  const p = kpuzzle.defaultPattern().applyTransformation(toT.invert()).applyTransformation(fromT);
  const solution = await experimentalSolve3x3x3IgnoringCenters(p);
  return parseMoves(normalize(solution.toString()));
}

// 完成状態から state を作る手順（3Dビューのセットアップ用）
export async function setupMovesFor(state: CubeState): Promise<number[]> {
  const sol = await solveState(state);
  return parseMoves(normalize(new Alg(sol.map((m) => MOVE_NAMES[m]).join(" ")).invert().toString()));
}

// WCA のランダム状態スクランブル
export async function randomScramble(): Promise<number[]> {
  const { randomScrambleForEvent } = await import("cubing/scramble");
  const alg = await randomScrambleForEvent("333");
  return parseMoves(normalize(alg.toString()));
}

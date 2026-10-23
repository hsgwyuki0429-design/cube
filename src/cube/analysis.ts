// ソルブの区間分割（CFOP: クロス / F2L / OLL / PLL）。状態の列から「最初に条件を満たした手」で区切る。
import { type CubeState, NORMAL, OPPOSITE, applyMove, faceletGeometry, isSolved } from "./model";

const GEOM = Array.from({ length: 54 }, (_, i) => faceletGeometry(i));
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const nonZero = (p: number[]) => p.filter((v) => v !== 0).length;

// 面 c を底面としたときの各条件で調べる facelet
const CROSS: number[][] = [];
const F2L: number[][] = [];
for (let c = 0; c < 6; c++) {
  CROSS.push(GEOM.map((g, i) => ({ g, i })).filter(({ g }) => dot(g.pos, NORMAL[c]) === 1 && nonZero(g.pos) === 2).map(({ i }) => i));
  F2L.push(GEOM.map((g, i) => ({ g, i })).filter(({ g }) => dot(g.pos, NORMAL[c]) >= 0).map(({ i }) => i));
}

// facelet i が自分の面のセンターと同じ色か（センターは動かないので面番号と比較）
const home = (s: CubeState, i: number) => s[i] === Math.floor(i / 9);

export const crossDone = (s: CubeState, c: number) => CROSS[c].every((i) => home(s, i));
export const f2lDone = (s: CubeState, c: number) => F2L[c].every((i) => home(s, i));
export function ollDone(s: CubeState, c: number): boolean {
  const o = OPPOSITE[c];
  for (let k = 0; k < 9; k++) if (s[o * 9 + k] !== o) return false;
  return true;
}

export interface Split {
  name: string;
  index: number; // その区間が終わった手の番号（0 = 開始時点で既に満たしていた）
}

export function cfopSplits(start: CubeState, moves: number[]): Split[] | null {
  const states: CubeState[] = [start];
  for (const m of moves) states.push(applyMove(states[states.length - 1], m));
  if (!isSolved(states[states.length - 1])) return null;
  // F2L が最も早く揃った面をクロスの面とみなす
  let bestFace = -1;
  let bestIdx = Infinity;
  for (let c = 0; c < 6; c++) {
    const idx = states.findIndex((s) => f2lDone(s, c));
    if (idx >= 0 && idx < bestIdx) {
      bestIdx = idx;
      bestFace = c;
    }
  }
  if (bestFace < 0) return null;
  const c = bestFace;
  const cross = states.findIndex((s) => crossDone(s, c));
  const f2l = states.findIndex((s, i) => i >= cross && f2lDone(s, c));
  const oll = states.findIndex((s, i) => i >= f2l && f2lDone(s, c) && ollDone(s, c));
  const pll = states.length - 1;
  return [
    { name: "クロス", index: cross },
    { name: "F2L", index: f2l },
    { name: "OLL", index: oll },
    { name: "PLL", index: pll },
  ];
}

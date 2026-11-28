// ソルブの区間分割（CFOP: クロス / F2L / OLL / PLL）。状態の列から「最初に条件を満たした手」で区切る。
import { dot3 as dot } from "../lib/util";
import { type CubeState, NORMAL, OPPOSITE, applyMove, faceletGeometry, isSolved } from "./model";

const GEOM = Array.from({ length: 54 }, (_, i) => faceletGeometry(i));
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

// F2L が最も早く揃った面（クロスの面）。揃わなければ -1
function crossFaceIn(states: CubeState[]): number {
  let bestFace = -1;
  let bestIdx = Infinity;
  for (let c = 0; c < 6; c++) {
    const idx = states.findIndex((s) => f2lDone(s, c));
    if (idx >= 0 && idx < bestIdx) {
      bestIdx = idx;
      bestFace = c;
    }
  }
  return bestFace;
}

// そのソルブでクロスを作った面（F2L が最も早く揃った面）。分からなければ -1
export function crossFaceOf(start: CubeState, moves: number[]): number {
  const states: CubeState[] = [start];
  for (const m of moves) states.push(applyMove(states[states.length - 1], m));
  return crossFaceIn(states);
}

export function cfopSplits(start: CubeState, moves: number[]): Split[] | null {
  const states: CubeState[] = [start];
  for (const m of moves) states.push(applyMove(states[states.length - 1], m));
  if (!isSolved(states[states.length - 1])) return null;
  // F2L が最も早く揃った面をクロスの面とみなす
  const c = crossFaceIn(states);
  if (c < 0) return null;
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

// 止めた後の画面・結果カードの区切り: クロス・F2L のペア 4 つ・OLL・PLL（その区間が終わった手の数。cfopSplits と同じ決まりで、F2L は
// 入ったスロットの数が 1〜4 になった最初の手）。揃わない・クロスの面が分からなければ null
export interface CfopPhase {
  name: string; // クロス・F2L 1〜4・OLL・PLL
  index: number; // その区間が終わった手の数（0 = 開始時点で既に満たしていた）
}

export function cfopPhases(start: CubeState, moves: number[]): { face: number; phases: CfopPhase[]; states: CubeState[] } | null {
  const states: CubeState[] = [start];
  for (const m of moves) states.push(applyMove(states[states.length - 1], m));
  const sp = cfopSplits(start, moves);
  if (!sp) return null;
  const c = crossFaceIn(states);
  const [cross, f2l, oll, pll] = sp.map((x) => x.index);
  // 入っているスロットの数（クロスの面 c の F2L のスロット: コーナーと縦のエッジが自分の場所）
  const SLOTS = SLOT_FACELETS[c];
  const pairs = (s: CubeState) => SLOTS.filter((fs) => fs.every((i) => home(s, i))).length;
  const out: CfopPhase[] = [{ name: "クロス", index: cross }];
  let from = cross;
  for (let k = 1; k <= 4; k++) {
    let i = k === 4 ? f2l : states.findIndex((s, j) => j >= from && crossDone(s, c) && pairs(s) >= k);
    if (i < 0 || i > f2l) i = f2l;
    out.push({ name: `F2L ${k}`, index: i });
    from = i;
  }
  out.push({ name: "OLL", index: oll }, { name: "PLL", index: pll });
  return { face: c, phases: out, states };
}

// クロスの面 c の F2L のスロット 4 つ（コーナー 3 枚とエッジ 2 枚の facelet）
const SLOT_FACELETS: number[][][] = Array.from({ length: 6 }, (_, c) => {
  const sides = [0, 1, 2, 3, 4, 5].filter((f) => f !== c && f !== OPPOSITE[c]);
  const out: number[][] = [];
  for (const a of sides)
    for (const b of sides) {
      if (a >= b || dot(NORMAL[a], NORMAL[b]) !== 0) continue;
      const corner = [0, 1, 2].map((k) => NORMAL[c][k] + NORMAL[a][k] + NORMAL[b][k]);
      const edge = [0, 1, 2].map((k) => NORMAL[a][k] + NORMAL[b][k]);
      const same = (p: readonly number[], q: number[]) => p[0] === q[0] && p[1] === q[1] && p[2] === q[2];
      out.push(GEOM.map((g, i) => ({ g, i })).filter(({ g }) => same(g.pos, corner) || same(g.pos, edge)).map(({ i }) => i));
    }
  return out;
});

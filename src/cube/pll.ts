// PLL の名前: OLL まで済んだ状態の最後の面のピースの並びが、どの PLL か（上の面の向きの 4 通り × 回す前後の AUF で照らす）。
// 止めた後の結果カードの「PLL T-perm」。DOM を知らない（tests/pll.test.ts）
import { OPPOSITE, applyMoves, isSolved, type CubeState } from "./model";
import { PLL, toCenterMoves } from "./algorithms";

// algorithms.ts の PLL と同じ順の名前
const NAMES = ["T", "Jb", "Ja", "Y", "F", "Aa", "Ab", "E", "H", "Ua", "Ub", "Ua", "Ub", "Z", "Ra", "Rb", "Na", "Nb", "V", "Ga", "Gb", "Gc", "Gd"];

// 上の面を f にして、縦の軸で 0〜3 回持ち替えた持ち方（toCenterMoves の先頭に付ける）
const PREFIXES = ["", "x", "x2", "x'", "z", "z'"].flatMap((a) => ["", "y", "y2", "y'"].map((b) => `${a} ${b}`.trim()));
const holdsFor = (f: number) => PREFIXES.filter((p) => toCenterMoves(`${p} U`)[0] === f * 3);

// 面 f を上にした PLL の手順（センター基準）: 名前と手順
const cache = new Map<number, { name: string; moves: number[] }[]>();
function algsFor(f: number) {
  let out = cache.get(f);
  if (!out) {
    out = [];
    for (const p of holdsFor(f)) PLL.forEach((alg, i) => out!.push({ name: NAMES[i], moves: toCenterMoves(`${p} ${alg}`) }));
    cache.set(f, out);
  }
  return out;
}

// s: OLL まで済んだ状態、cross: クロスの面。PLL の名前（"T" など）。AUF だけで揃うなら "skip"。分からなければ null
export function pllName(s: CubeState, cross: number): string | null {
  const f = OPPOSITE[cross];
  const auf = [[], [f * 3], [f * 3 + 1], [f * 3 + 2]];
  for (const b of auf) if (isSolved(applyMoves(s, b))) return "skip";
  for (const { name, moves } of algsFor(f))
    for (const a of auf) {
      const s1 = applyMoves(s, [...a, ...moves]);
      for (const b of auf) if (isSolved(applyMoves(s1, b))) return name;
    }
  return null;
}

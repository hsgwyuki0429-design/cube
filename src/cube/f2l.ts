// F2L の進み具合: クロスの面を下にしたときの 4 つのスロット（コーナー 1 つ + エッジ 1 つの組）と、手順のどの時点で次にどのスロットが
// 入るか。記録の詳しい画面の 3D で、次に入るペアを光らせる・入るスロットの側から見せるのに使う。DOM を知らない
import { crossDone } from "./analysis";
import { type CubeState, NORMAL, OPPOSITE, applyMove, faceletGeometry } from "./model";

const GEOM = Array.from({ length: 54 }, (_, i) => faceletGeometry(i));
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const same = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const add = (...vs: (readonly number[])[]) => [0, 1, 2].map((k) => vs.reduce((s, v) => s + v[k], 0));

// スロット = クロスの面 c に接する 2 つの側面 a・b（a < b）
export type Slot = [number, number];

export function slotsFor(c: number): Slot[] {
  const sides = [0, 1, 2, 3, 4, 5].filter((f) => f !== c && f !== OPPOSITE[c]);
  const out: Slot[] = [];
  for (const a of sides) for (const b of sides) if (a < b && dot(NORMAL[a], NORMAL[b]) === 0) out.push([a, b]);
  return out;
}

// スロットのコーナー（3 枚）とエッジ（2 枚）の facelet
export function slotFacelets(c: number, [a, b]: Slot): number[] {
  const corner = add(NORMAL[c], NORMAL[a], NORMAL[b]);
  const edge = add(NORMAL[a], NORMAL[b]);
  return GEOM.map((g, i) => ({ g, i }))
    .filter(({ g }) => same(g.pos, corner) || same(g.pos, edge))
    .map(({ i }) => i);
}

const home = (s: CubeState, i: number) => s[i] === Math.floor(i / 9);
export const slotDone = (s: CubeState, c: number, slot: Slot) => slotFacelets(c, slot).every((i) => home(s, i));

export interface F2LStep {
  slot: Slot; // 次に入るスロット
  doneAt: number; // そのスロットが入った手の数（moves の先頭からこの数だけ回した後に入っている）
  solved: Slot[]; // いま入っているスロット
}

// k 手回した後（k = 0..n）ごとに、F2L の途中なら次に入るスロット。クロスの前・F2L が済んだ後・この先で入らないときは null
export function f2lPlan(start: CubeState, moves: number[], c: number): (F2LStep | null)[] {
  const states: CubeState[] = [start];
  for (const m of moves) states.push(applyMove(states[states.length - 1], m));
  const slots = slotsFor(c);
  const done = states.map((s) => slots.map((sl) => slotDone(s, c, sl)));
  const out: (F2LStep | null)[] = [];
  let crossed = false;
  for (let k = 0; k < states.length; k++) {
    crossed ||= crossDone(states[k], c);
    if (!crossed || done[k].every(Boolean)) {
      out.push(null);
      continue;
    }
    let step: F2LStep | null = null;
    for (let j = k + 1; j < states.length && !step; j++) {
      const i = slots.findIndex((_, x) => done[j][x] && !done[k][x]);
      if (i >= 0) step = { slot: slots[i], doneAt: j, solved: slots.filter((_, x) => done[k][x]) };
    }
    out.push(step);
  }
  return out;
}

// cubing.js の 3x3x3 のピースの並び（KPuzzle の EDGES・CORNERS）
const FACE_LETTER = ["U", "R", "F", "D", "L", "B"];
const EDGES = ["UF", "UR", "UB", "UL", "DF", "DR", "DB", "DL", "FR", "FL", "BR", "BL"];
const CORNERS = ["UFR", "URB", "UBL", "ULF", "DRF", "DFL", "DLB", "DBR"];
const key = (faces: number[]) =>
  faces
    .map((f) => FACE_LETTER[f])
    .sort()
    .join("");
const EDGE_KEY = EDGES.map((e) => e.split("").sort().join(""));
const CORNER_KEY = CORNERS.map((e) => e.split("").sort().join(""));

// 次に入るペアを光らせる cubing.js の stickering mask（experimentalStickeringMaskOrbits）。クロスのエッジ・入ったスロット・
// 次に入るペアはふつう、ほかは暗く。F2L の途中でなければ null（全部ふつう）
export function f2lMask(c: number, step: F2LStep | null): string | null {
  if (!step) return null;
  const bright = new Set<string>();
  for (const f of [0, 1, 2, 3, 4, 5]) if (f !== c && f !== OPPOSITE[c]) bright.add(key([c, f])); // クロスのエッジ
  for (const [a, b] of [...step.solved, step.slot]) {
    bright.add(key([c, a, b]));
    bright.add(key([a, b]));
  }
  const edges = EDGE_KEY.map((k) => (bright.has(k) ? "-" : "D")).join("");
  const corners = CORNER_KEY.map((k) => (bright.has(k) ? "-" : "D")).join("");
  return `EDGES:${edges},CORNERS:${corners},CENTERS:------`;
}

// スロットの向き（キューブ固定の座標で、クロスの面に平行な方向）
export const slotDir = ([a, b]: Slot): [number, number, number] => add(NORMAL[a], NORMAL[b]) as [number, number, number];

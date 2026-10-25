// 手順の知識: 人は覚えた手順（PLL・OLL・F2L・トリガー）を回すので、直前の数手に続く手が「知っている並びの続き」で
// なければ、デコーダでその手のコストを少し上げる。観測だけでは見分けにくい区間（正面しか見えない・指で隠れた）で、
// 手順として自然な読みを選びやすくし、手順の途中に雑音の手を挟む読みを不利にする。
// 続きの手を安くする向きは使わない: 手を足して誤読を説明する方が安くなり、余計な手が増えた（実際の T-perm の動画）。
//
// 並びは持ち方によらない形で数える: キューブ全体の向き 24 通りと左右反転で写り合う並びを同じものとする
// （センター基準の手なので、同じ T-perm でもどの面を前にして回したかで面の名前が変わる）。手順の逆（後ろ向きの再構成）も入れる。
// 自分のソルブの手順（解析で確定したもの）も加えると、その人の癖のある手順も覚える。
import { ALL_ALGORITHMS, toCenterMoves } from "../cube/algorithms";
import { NUM_MOVES, ORIENTATIONS, cubeFaceAt, inverseMove, moveFace } from "../cube/model";

const NONE = 18; // 直前の手がない
const B = 19;
export const CTX_SIZE = B * B * B; // 直前 3 手（古い順）
export const packContext = (a: number, b: number, c: number) => (a * B + b) * B + c;
export const shiftContext = (ctx: number, m: number) => (ctx % (B * B)) * B + m;
export const EMPTY_CONTEXT = packContext(NONE, NONE, NONE);

export interface PriorOptions {
  penalty4: number; // 直前 3 手 + この手が知っている並びでない
  penalty3: number; // 直前 2 手 + この手が知っている並びでない
}

export const DEFAULT_PRIOR: PriorOptions = { penalty4: 0.2, penalty3: 0.1 };

// 48 通りの対称（回転 24 × 左右反転）による手の写し
const SYMMETRIES: Int8Array[] = (() => {
  const out: Int8Array[] = [];
  const mirrorFace = [0, 4, 2, 3, 1, 5]; // R ↔ L
  for (let o = 0; o < ORIENTATIONS.length; o++)
    for (const mirror of [false, true]) {
      const map = new Int8Array(NUM_MOVES);
      for (let m = 0; m < NUM_MOVES; m++) {
        let f = moveFace(m);
        let a = m % 3;
        if (mirror) {
          f = mirrorFace[f];
          a = 2 - a; // 鏡に映すと回る向きが逆
        }
        map[m] = cubeFaceAt(o, f) * 3 + a;
      }
      out.push(map);
    }
  return out;
})();

const code = (seq: number[]) => seq.reduce((c, m) => c * NUM_MOVES + m, 0);

export class MovePrior {
  // table[ctx * 18 + m] = 直前の手が ctx のときの手 m のコストの上乗せ（0 以上）
  readonly table: Float32Array;

  constructor(sequences: number[][], options: PriorOptions = DEFAULT_PRIOR) {
    // 並びの 48 通りの写しをすべて入れておく（表を作るときは番号を引くだけ）
    const c3 = new Set<number>();
    const c4 = new Set<number>();
    const add = (seq: number[]) => {
      for (const sym of SYMMETRIES) {
        const s = seq.map((m) => sym[m]);
        for (let i = 0; i + 3 <= s.length; i++) c3.add(code(s.slice(i, i + 3)));
        for (let i = 0; i + 4 <= s.length; i++) c4.add(code(s.slice(i, i + 4)));
      }
    };
    for (const seq of sequences) {
      add(seq);
      add(seq.slice().reverse().map(inverseMove)); // 逆の手順（後ろ向きの再構成で同じ表を使う）
    }
    this.table = new Float32Array(CTX_SIZE * NUM_MOVES);
    for (let a = 0; a < B; a++)
      for (let b = 0; b < B; b++)
        for (let c = 0; c < NONE; c++)
          for (let m = 0; m < NUM_MOVES; m++) {
            let d = 0;
            if (b < NONE) {
              if (!c3.has(code([b, c, m]))) d += options.penalty3;
              if (a < NONE && !c4.has(code([a, b, c, m]))) d += options.penalty4;
            }
            this.table[packContext(a, b, c) * NUM_MOVES + m] = d;
          }
  }

  penalty(ctx: number, m: number): number {
    return this.table[ctx * NUM_MOVES + m];
  }
}

let builtin: MovePrior | null = null;
const personalCache = new Map<string, MovePrior>();

// 組み込みの手順（＋自分のソルブの手順）から作った表。同じ入力なら作り直さない
export function movePrior(personal: number[][] = []): MovePrior {
  if (!personal.length) return (builtin ??= new MovePrior(ALL_ALGORITHMS.map(toCenterMoves)));
  const key = personal.map((s) => s.join(",")).join(";");
  let p = personalCache.get(key);
  if (!p) {
    p = new MovePrior([...ALL_ALGORITHMS.map(toCenterMoves), ...personal]);
    personalCache.clear();
    personalCache.set(key, p);
  }
  return p;
}

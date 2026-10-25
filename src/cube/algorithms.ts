// よく使われる手順（PLL・OLL・F2L・トリガー）。追跡のデコーダが「手順の続きらしい手」を少し優先するのに使う
// （src/track/prior.ts）。人は手順を覚えて回すので、観測だけでは見分けにくい区間も、知っている並びなら選びやすい。
//
// 手順は持ち替え（x y z）・ワイドムーブ（r Rw）・中層（M E S）を含む書き方のまま置き、センター基準の 18 手に直して使う
// （このアプリの状態はセンター基準なので、r は L と持ち替え x、M は R L' と x' と同じ）。
import { FACES, MOVE_NAMES, moveIndex } from "./model";

export const PLL = [
  "R U R' U' R' F R2 U' R' U' R U R' F'", // T
  "R U R' F' R U R' U' R' F R2 U' R'", // Jb
  "x R2 F R F' R U2 r' U r U2 x'", // Ja
  "F R U' R' U' R U R' F' R U R' U' R' F R F'", // Y
  "R' U' F' R U R' U' R' F R2 U' R' U' R U R' U R", // F
  "x R' U R' D2 R U' R' D2 R2 x'", // Aa
  "x R2 D2 R U R' D2 R U' R x'", // Ab
  "x' R U' R' D R U R' D' R U R' D R U' R' D' x", // E
  "M2 U M2 U2 M2 U M2", // H
  "M2 U M U2 M' U M2", // Ua
  "M2 U' M U2 M' U' M2", // Ub
  "R U' R U R U R U' R' U' R2", // Ua
  "R2 U R U R' U' R' U' R' U R'", // Ub
  "M' U M2 U M2 U M' U2 M2", // Z
  "R U' R' U' R U R D R' U' R D' R' U2 R'", // Ra
  "R2 F R U R U' R' F' R U2 R' U2 R", // Rb
  "R U R' U R U R' F' R U R' U' R' F R2 U' R' U2 R U' R'", // Na
  "R' U R U' R' F' U' F R U R' F R' F' R U' R", // Nb
  "R' U R' U' y R' F' R2 U' R' U R' F R F", // V
  "R2 U R' U R' U' R U' R2 U' D R' U R D'", // Ga
  "R' U' R U D' R2 U R' U R U' R U' R2 D", // Gb
  "R2 U' R U' R U R' U R2 U D' R U' R' D", // Gc
  "R U R' U' D R2 U' R U' R' U R' U R2 D'", // Gd
];

export const OLL = [
  "R U R' U R U2 R'", // Sune
  "R U2 R' U' R U' R'", // Antisune
  "R U R' U R U' R' U R U2 R'", // H
  "R U2 R2 U' R2 U' R2 U2 R", // Pi
  "R2 D R' U2 R D' R' U2 R'", // ヘッドライト
  "r U R' U' r' F R F'", // T
  "F R' F' r U R U' r'", // 蝶ネクタイ
  "F R U R' U' F'",
  "f R U R' U' f'",
  "R U R' U' R' F R F'",
  "F R U R' U' R U R' U' F'",
  "r U R' U R U2 r'",
  "r' U' R U' R' U2 r",
  "r U2 R' U' R U' r'",
  "r' U2 R U R' U r",
  "R U R' U' M' U R U' r'",
  "R' U' R' F R F' U R",
  "M U R U R' U' M2 U R U' r'",
  "R U2 R2 F R F' U2 R' F R F'",
  "F R U R' U' R F' r U R' U' r'",
  "R' F R U R' U' F' U R",
  "F U R U' R' F'",
  "R U R2 U' R' F R U R U' F'",
  "r U r' U2 r U2 R' U2 R U' r'",
];

export const F2L = [
  "R U R'",
  "R U' R'",
  "U R U' R'",
  "U' R U R'",
  "R U2 R' U' R U R'",
  "U' R U' R' U R U R'",
  "R U' R' U R U' R'",
  "U' R U2 R' U2 R U' R'",
  "U R U2 R' U R U' R'",
  "R U2 R' U R U' R'",
  "U' R U R' U2 R U' R'",
  "R U R' U' R U R' U' R U R'",
  "y' U' L' U L",
  "y' L' U' L",
  "y' U L' U' L",
  "F' U' F",
  "U' F' U F",
  "R' F R F'",
  "F R' F' R",
  "R U' R' U' F' U F",
  "U R U' R' U' F' U F",
  "R U R' U2 R U R' U' R U R'",
  "U' R U' R' U2 R U' R'",
  "d R' U' R d' R U R'",
];

// 手順の中によく出る短い並び
export const TRIGGERS = ["R U R' U'", "U R U' R'", "R' F R F'", "F R U R' U' F'", "R U R' U R U2 R'", "L' U' L U", "R' U' R U", "R U2 R'", "R' U2 R"];

// 持ち替え・ワイド・中層を含む手順 → センター基準の手の番号
export function toCenterMoves(alg: string): number[] {
  // label[i] = いま i の位置（U R F D L B）にあるセンターの面
  let label = [0, 1, 2, 3, 4, 5];
  const out: number[] = [];
  const rotate = (axis: "x" | "y" | "z", times: number) => {
    // x: F → U、y: R → F、z: L → U（新しい位置 ← 前の位置）
    const cycles = { x: [0, 2, 3, 5], y: [2, 1, 5, 4], z: [0, 4, 3, 1] }[axis];
    for (let n = 0; n < times; n++) {
      const next = [...label];
      // cycles[a] の位置に cycles[a+1] の位置のセンターが来る
      for (let a = 0; a < 4; a++) next[cycles[a]] = label[cycles[(a + 1) % 4]];
      label = next;
    }
  };
  const turn = (pos: number, amount: number) => {
    const q = ((amount % 4) + 4) % 4;
    if (q) out.push(label[pos] * 3 + q - 1);
  };
  for (const tok of alg.trim().split(/\s+/).filter(Boolean)) {
    const m = /^([URFDLBMESxyzurfdlb])(w?)(2?)('?)$/.exec(tok.replace("’", "'"));
    if (!m) throw new Error(`unknown token: ${tok}`);
    const [, base, w, two, prime] = m;
    const amount = (two ? 2 : 1) * (prime ? -1 : 1);
    const q = ((amount % 4) + 4) % 4; // 時計回りの回数（0..3）
    const face = (c: string) => FACES.indexOf(c.toUpperCase() as (typeof FACES)[number]);
    if ("xyz".includes(base)) {
      rotate(base as "x" | "y" | "z", q);
      continue;
    }
    if ("MES".includes(base)) {
      // M は L と同じ向き: R L' x'。E は D と同じ向き: U D' y'。S は F と同じ向き: F' B z
      const [a, b, axis, dir] = { M: [1, 4, "x", -1], E: [0, 3, "y", -1], S: [2, 5, "z", 1] }[base] as [number, number, "x" | "y" | "z", number];
      if (base === "S") {
        turn(a, -q);
        turn(b, q);
      } else {
        turn(a, q);
        turn(b, -q);
      }
      rotate(axis, (((dir * q) % 4) + 4) % 4);
      continue;
    }
    const f = face(base);
    if (base === base.toLowerCase() || w) {
      // ワイド: 反対の面を同じ向きに回し、その面の向きに持ち替える（r = L x、u = D y、f = B z…）
      const opp = [3, 4, 5, 0, 1, 2][f];
      turn(opp, q);
      const axis = (["y", "x", "z", "y", "x", "z"] as const)[f];
      const sign = [1, 1, 1, -1, -1, -1][f];
      rotate(axis, (((sign * q) % 4) + 4) % 4);
      continue;
    }
    turn(f, q);
  }
  return out;
}

export const moveNames = (moves: number[]) => moves.map((m) => MOVE_NAMES[m]).join(" ");
export const parseCenterMoves = (s: string) => s.trim().split(/\s+/).filter(Boolean).map(moveIndex);

export const ALL_ALGORITHMS = [...PLL, ...OLL, ...F2L, ...TRIGGERS];

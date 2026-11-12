// X クロス（クロス + F2L のペア 1 組）の最短手順。DOM もカメラも知らない（Worker でもテストでも動く）。
//
// キューブ全体ではなく、関わる 6 個のピース（クロスのエッジ 4 つ・ペアのコーナーとエッジ）がどこにあるか（ステッカー 1 枚の位置。
// 向きも分かる）だけを追う。手で各ステッカーがどこへ移るかは MOVE_DEST。最短は IDA*（深さを 1 ずつ増やす深さ優先）で、
// 残りの手数の下限は「クロスの 4 エッジを揃える最短手数」と「ペアのコーナー・ペアのエッジ・クロスのエッジ 1 つを揃える最短手数」の表
// （揃った形から幅優先で作る）の大きい方。4 組のペアのうち、いちばん短く済むものを返す。
import { dot3 as dot } from "../lib/util";
import { type CubeState, MOVE_DEST, NORMAL, NUM_MOVES, OPPOSITE, faceletGeometry, moveFace } from "./model";
import { PARTNERS, stickerIdAt } from "./stickers";

const EDGE_F: number[] = [];
const CORNER_F: number[] = [];
const EIDX = new Int8Array(54).fill(-1);
const CIDX = new Int8Array(54).fill(-1);
for (let f = 0; f < 54; f++) {
  if (PARTNERS[f].length === 1) {
    EIDX[f] = EDGE_F.length;
    EDGE_F.push(f);
  } else if (PARTNERS[f].length === 2) {
    CIDX[f] = CORNER_F.length;
    CORNER_F.push(f);
  }
}
// 手 m でエッジ・コーナーのステッカーの位置（0..23）がどこへ移るか
const EMOVE = new Int8Array(NUM_MOVES * 24);
const CMOVE = new Int8Array(NUM_MOVES * 24);
for (let m = 0; m < NUM_MOVES; m++)
  for (let k = 0; k < 24; k++) {
    EMOVE[m * 24 + k] = EIDX[MOVE_DEST[m][EDGE_F[k]]];
    CMOVE[m * 24 + k] = CIDX[MOVE_DEST[m][CORNER_F[k]]];
  }


// 面 c のクロスのエッジ（面 c の上のステッカー）と、4 組のペア（面 c の上のコーナーのステッカー・ペアのエッジのステッカー）
function piecesOf(c: number): { cross: number[]; pairs: { corner: number; edge: number }[] } {
  const cross = [1, 3, 5, 7].map((k) => EIDX[c * 9 + k]);
  const pairs = [0, 2, 6, 8].map((k) => {
    const corner = c * 9 + k;
    const [a, b] = PARTNERS[corner].map((f) => Math.floor(f / 9));
    // 面 a と面 b の間のエッジのうち、面 c に触れていないもの（a の側のステッカー）
    const edge = EDGE_F.find((f) => Math.floor(f / 9) === a && Math.floor(PARTNERS[f][0] / 9) === b && dot(faceletGeometry(f).pos, NORMAL[c]) === 0)!;
    return { corner: CIDX[corner], edge: EIDX[edge] };
  });
  return { cross, pairs };
}

// 揃った形から幅優先で、各配置を揃える最短手数の表を作る。pieces: 追うステッカー（エッジは 0..23、コーナーは 24 + 0..23）
function distanceTable(pieces: number[]): Uint8Array {
  const n = pieces.length;
  const table = new Uint8Array(24 ** n).fill(255);
  const enc = (p: number[]) => p.reduce((a, v) => a * 24 + v, 0);
  const isCorner = pieces.map((p) => p >= 24);
  const start = pieces.map((p) => p % 24);
  table[enc(start)] = 0;
  let frontier = [enc(start)];
  for (let d = 0; frontier.length; d++) {
    const next: number[] = [];
    const cur = new Array<number>(n);
    for (const code of frontier) {
      let x = code;
      for (let i = n - 1; i >= 0; i--) {
        cur[i] = x % 24;
        x = Math.floor(x / 24);
      }
      for (let m = 0; m < NUM_MOVES; m++) {
        let k = 0;
        for (let i = 0; i < n; i++) k = k * 24 + (isCorner[i] ? CMOVE : EMOVE)[m * 24 + cur[i]];
        if (table[k] === 255) {
          table[k] = d + 1;
          next.push(k);
        }
      }
    }
    frontier = next;
  }
  return table;
}

const crossTables = new Map<number, Uint8Array>();
const pairTables = new Map<string, Uint8Array>();

export interface XCrossResult {
  moves: number[]; // キューブ固定の手（センター基準）
  slot: number; // 揃えたペア（面 c の上のコーナー 0, 2, 6, 8 の順の番号）
}

// 状態 state で、面 c のクロスとペア 1 組を揃える最短手順（4 組のうちいちばん短いもの）。maxDepth までに見つからなければ null
export function solveXCross(state: CubeState, c: number, maxDepth = 14): XCrossResult | null {
  const { cross, pairs } = piecesOf(c);
  let ct = crossTables.get(c);
  if (!ct) crossTables.set(c, (ct = distanceTable(cross)));
  const pts = pairs.map((p, slot) =>
    cross.map((e, j) => {
      const key = `${c}:${slot}:${j}`;
      let t = pairTables.get(key);
      if (!t) pairTables.set(key, (t = distanceTable([p.corner + 24, p.edge, e])));
      return t;
    }),
  );
  // いまの状態で、追うステッカー（揃った位置 = 自分の facelet 番号）がどこにあるか
  const where = new Int8Array(54).fill(-1);
  for (let f = 0; f < 54; f++) {
    const id = stickerIdAt(state, f);
    if (id >= 0) where[id] = f;
  }
  const posE = (k: number) => EIDX[where[EDGE_F[k]]];
  const posC = (k: number) => CIDX[where[CORNER_F[k]]];
  if ([...cross, ...pairs.map((p) => p.edge)].some((k) => posE(k) < 0) || pairs.some((p) => posC(p.corner) < 0)) return null;

  const path: number[] = [];
  const search = (slot: number, e: number[], pe: number, co: number, g: number, bound: number, last: number): boolean => {
    const h = Math.max(ct![((e[0] * 24 + e[1]) * 24 + e[2]) * 24 + e[3]], ...e.map((x, j) => pts[slot][j][(co * 24 + pe) * 24 + x]));
    if (h === 0) return true;
    if (g + h > bound) return false;
    for (let m = 0; m < NUM_MOVES; m++) {
      const f = moveFace(m);
      if (last >= 0 && (f === last || (OPPOSITE[f] === last && f > last))) continue;
      const ne = e.map((x) => EMOVE[m * 24 + x]);
      path.push(m);
      if (search(slot, ne, EMOVE[m * 24 + pe], CMOVE[m * 24 + co], g + 1, bound, f)) return true;
      path.pop();
    }
    return false;
  };
  const e0 = cross.map(posE);
  for (let bound = 0; bound <= maxDepth; bound++)
    for (let slot = 0; slot < 4; slot++) {
      path.length = 0;
      if (search(slot, e0, posE(pairs[slot].edge), posC(pairs[slot].corner), 0, bound, -1)) return { moves: [...path], slot };
    }
  return null;
}

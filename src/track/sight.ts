// 1 フレームの読みの「見え方」: 面（カメラの面のスロット）ごとに、マスに読めたステッカーの ID・マーカーを直接読んだか・マーカーの
// 向き（格子に対して 90° 単位）・面の外枠。スロットに頼らずに面の置き方を決める（下の placeAll。ライブのスロットの確かめ slotCheck.ts・
// ライブの記録 liveLog.ts で使う）。もとはお蔵入りにしたピースの時刻表（2026-11 に削除。CLAUDE.md）の材料。DOM もカメラも知らない
import { PARTNERS } from "../cube/stickers";
import { type Mat3, type Pt, applyH, invert3 } from "../vision/homography";

export interface SightFace {
  slot: number;
  ids: number[]; // 9 マス。-1 = 読めない
  // マーカーの向き: マーカーの上辺が、格子の 0 = 上（行 0 の側）・1 = 右・2 = 下・3 = 左 を向く。-1 = マーカーを直接は読んでいない
  rot: number[];
  held?: boolean; // 1 列・1 枚の面
  // 面の外枠の 4 隅（画像の座標。格子の左上・右上・右下・左下 = 面の座標の (0,0)・(3,0)・(3,3)・(0,3)）。面どうしがどの辺で
  // 接しているかを、スロットの割り当てに頼らずに決める（placeAll）
  quad: number[];
}

export interface SightFrame {
  t: number;
  faces: SightFace[];
}

interface FaceLike {
  slot: number;
  H: Mat3;
  ids?: number[];
  held?: boolean;
  layer?: { cells: number[]; H: Mat3 };
}

// マーカーの四隅（左上・右上・右下・左下。上 = 印刷したマーカーの上辺）から、マス（0〜8）と向きを決める。面の外なら null
function place(inv: Mat3, q: Pt[]): { cell: number; rot: number } | null {
  const p = q.map((c) => applyH(inv, c[0], c[1]));
  const cx = (p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4;
  const cy = (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4;
  if (!(cx > 0 && cx < 3 && cy > 0 && cy < 3)) return null;
  // 上向き = 下辺の真ん中 → 上辺の真ん中
  const ux = p[0][0] + p[1][0] - p[2][0] - p[3][0];
  const uy = p[0][1] + p[1][1] - p[2][1] - p[3][1];
  const rot = Math.abs(ux) > Math.abs(uy) ? (ux > 0 ? 1 : 3) : uy < 0 ? 0 : 2;
  return { cell: Math.floor(cy) * 3 + Math.floor(cx), rot };
}

export function sightFrame(t: number, r: { faces: FaceLike[]; quads: Pt[][] }): SightFrame {
  const faces: SightFace[] = [];
  for (const f of r.faces) {
    if (!f.ids) continue;
    const rot = new Array<number>(9).fill(-1);
    const votes = new Int8Array(36);
    const grids: { inv: Mat3; cells: number[] | null }[] = [];
    const inv = invert3(f.H);
    if (inv) grids.push({ inv, cells: null });
    const linv = f.layer ? invert3(f.layer.H) : null;
    if (linv) grids.push({ inv: linv, cells: f.layer!.cells });
    for (const q of r.quads)
      for (const g of grids) {
        const at = place(g.inv, q);
        if (!at) continue;
        // 本体の格子は層のマス以外、層の格子は層のマスだけ
        const inLayer = !!f.layer?.cells.includes(at.cell);
        if (g.cells ? !inLayer : inLayer) continue;
        votes[at.cell * 4 + at.rot]++;
      }
    for (let c = 0; c < 9; c++) {
      if (f.ids[c] < 0) continue;
      let best = -1;
      let n = 0;
      let total = 0;
      for (let k = 0; k < 4; k++) {
        total += votes[c * 4 + k];
        if (votes[c * 4 + k] > n) {
          n = votes[c * 4 + k];
          best = k;
        }
      }
      // 向きの食い違うマーカーが同じマスにあれば、直接読んだことにしない
      if (best >= 0 && n === total) rot[c] = best;
    }
    const quad: number[] = [];
    for (const [x, y] of [[0, 0], [3, 0], [3, 3], [0, 3]]) {
      const p = applyH(f.H, x, y);
      quad.push(Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10);
    }
    faces.push({ slot: f.slot, ids: Array.from(f.ids), rot, quad, ...(f.held ? { held: true } : {}) });
  }
  return { t, faces };
}

// ---- 面の置き方（スロットに頼らない） ----
// 面の辺: 0 = 上（行 0 の側）・1 = 右（列 2 の側）・2 = 下・3 = 左。NEIGHBOR[F * 4 + k] = 面 F の辺 k で接する面 F' と、F' の側の辺 k'（F' * 4 + k'）
const SIDE_CELL = [1, 5, 7, 3];
const NEIGHBOR = new Uint8Array(24);
for (let f = 0; f < 6; f++)
  for (let k = 0; k < 4; k++) {
    const p = PARTNERS[f * 9 + SIDE_CELL[k]][0];
    NEIGHBOR[f * 4 + k] = Math.floor(p / 9) * 4 + SIDE_CELL.indexOf(p % 9);
  }
// CELL_TURN[r * 9 + c]: 読んだ格子のマス c が、面の決まった並びではどのマスか。r = 面の決まった並びの上の辺が、格子のどの辺にあるか
// （格子は決まった並びを時計回りに r × 90° 回したもの）。マーカーの向きは 格子での向き − r
export const CELL_TURN = new Uint8Array(36);
for (let r = 0; r < 4; r++)
  for (let c = 0; c < 9; c++) {
    let row = Math.floor(c / 3);
    let col = c % 3;
    for (let i = 0; i < r; i++) [row, col] = [2 - col, row];
    CELL_TURN[r * 9 + c] = row * 3 + col;
  }

export const isCenter = (id: number) => id % 9 === 4;

// 面 a の辺 i と面 b の辺 j が重なっているか（外枠は左上から時計回り。接する辺は逆向きに重なる）。重なりの悪さ（辺の長さに対する割合）
export function touching(a: number[], b: number[], i: number, j: number): number {
  const p = (q: number[], k: number): [number, number] => [q[(k & 3) * 2], q[(k & 3) * 2 + 1]];
  const d = (u: [number, number], v: [number, number]) => Math.hypot(u[0] - v[0], u[1] - v[1]);
  const a0 = p(a, i);
  const a1 = p(a, i + 1);
  const b0 = p(b, j);
  const b1 = p(b, j + 1);
  return (d(a0, b1) + d(a1, b0)) / (d(a0, a1) + d(b0, b1));
}

export interface Placed {
  face: number; // キューブの面
  r: number; // 面の決まった並びの上の辺が、格子のどの辺にあるか
}

// 面 fs を、基準の面 root を (face0, r0) に置いたときの置き方（つながらない面は null）。センターが食い違えば null を返す
export function placeAll(fs: SightFace[], links: number[][], root: number, face0: number, r0: number): (Placed | null)[] | null {
  const out: (Placed | null)[] = fs.map(() => null);
  out[root] = { face: face0, r: r0 };
  const queue = [root];
  while (queue.length) {
    const a = queue.pop()!;
    const pa = out[a]!;
    for (const [x, y, i, j] of links) {
      if (x !== a && y !== a) continue;
      const b = x === a ? y : x;
      const sa = x === a ? i : j;
      const sb = x === a ? j : i;
      const nb = NEIGHBOR[pa.face * 4 + ((sa - pa.r + 4) & 3)];
      const pb = { face: nb >> 2, r: (sb - (nb & 3) + 4) & 3 };
      const c = fs[b].ids[4];
      if (c >= 0 && fs[b].rot[4] >= 0 && isCenter(c) && Math.floor(c / 9) !== pb.face) return null;
      if (out[b]) {
        if (out[b]!.face !== pb.face || out[b]!.r !== pb.r) return null;
        continue;
      }
      out[b] = pb;
      queue.push(b);
    }
  }
  return out;
}

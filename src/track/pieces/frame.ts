// 1 フレームの読みを、ピースの時刻表（table.ts）の材料にする: 面（カメラの面のスロット）ごとに、マスに読めたステッカーの ID・
// マーカーを直接読んだか・マーカーの向き（格子に対して 90° 単位）。DOM もカメラも知らない
import { type Mat3, type Pt, applyH, invert3 } from "../../vision/homography";

export interface SightFace {
  slot: number;
  ids: number[]; // 9 マス。-1 = 読めない
  // マーカーの向き: マーカーの上辺が、格子の 0 = 上（行 0 の側）・1 = 右・2 = 下・3 = 左 を向く。-1 = マーカーを直接は読んでいない
  rot: number[];
  held?: boolean; // 1 列・1 枚の面
  // 面の外枠の 4 隅（画像の座標。格子の左上・右上・右下・左下 = 面の座標の (0,0)・(3,0)・(3,3)・(0,3)）。面どうしがどの辺で
  // 接しているか・面の向きの続きぐあいを、スロットの割り当てに頼らずに決める（table.ts）
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

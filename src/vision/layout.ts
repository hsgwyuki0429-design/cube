// 見つかった面（格子）を、カメラフレームの面（F=正面, U=上, R=右, L=左, D=下）と向きに割り当てる。
//
// 基準面（アンカー）をカメラフレームの F とする。アンカーの向きは、列方向が画像の +x（または前フレームの
// 向き）に最も近い回転を選ぶ。他の面は、アンカー平面に射影したときの位置（上下左右）でスロットを決め、
// 「列が増える方向 = アンカー平面の x が増える方向、行が増える方向 = y が増える方向」になる回転を選ぶ。
// これは CLAUDE.md の展開図フレーム（各面を F の隣に開いたときの向き）と一致する。
import { D, F, L, R, U } from "../cube/model";
import { type Mat3, type Pt, applyH, invertH } from "./homography";
import type { LatticeFace } from "./lattice";

export interface PlacedFace {
  slot: number;
  rot: number;
  H: Mat3;
  found: number;
  latticeIndex: number;
}

// スロットのセル (row, col) → 格子セル (lu, lv)
export function latticeCell(rot: number, row: number, col: number): [number, number] {
  switch (rot & 3) {
    case 0:
      return [col, row];
    case 1:
      return [2 - row, col];
    case 2:
      return [2 - col, 2 - row];
    default:
      return [row, 2 - col];
  }
}

// 格子の連続座標 (u, v) → スロットの連続座標 (x = 列方向, y = 行方向)
function latticeToSlot(rot: number, u: number, v: number): Pt {
  switch (rot & 3) {
    case 0:
      return [u, v];
    case 1:
      return [v, 3 - u];
    case 2:
      return [3 - u, 3 - v];
    default:
      return [3 - v, u];
  }
}

// スロットの連続座標 → 画像
export function slotPoint(face: { H: Mat3; rot: number }, x: number, y: number): Pt {
  // latticeToSlot の逆
  let u: number, v: number;
  switch (face.rot & 3) {
    case 0:
      [u, v] = [x, y];
      break;
    case 1:
      [u, v] = [3 - y, x];
      break;
    case 2:
      [u, v] = [3 - x, 3 - y];
      break;
    default:
      [u, v] = [y, 3 - x];
  }
  return applyH(face.H, u, v);
}

export const cellCenter = (face: { H: Mat3; rot: number }, cell: number): Pt => slotPoint(face, (cell % 3) + 0.5, Math.floor(cell / 3) + 0.5);

export function faceArea(H: Mat3): number {
  const p = [applyH(H, 0, 0), applyH(H, 3, 0), applyH(H, 3, 3), applyH(H, 0, 3)];
  let a = 0;
  for (let i = 0; i < 4; i++) a += p[i][0] * p[(i + 1) % 4][1] - p[(i + 1) % 4][0] * p[i][1];
  return Math.abs(a) / 2;
}

// アンカーの列方向（画像上の角度）
export function colAngle(face: { H: Mat3; rot: number }): number {
  const a = slotPoint(face, 0.5, 1.5);
  const b = slotPoint(face, 2.5, 1.5);
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

// スロットごとの、アンカーと共有する辺: [自分の端点1, 端点2, アンカー側の端点1, 端点2]（スロット座標）
const SHARED_EDGE: Record<number, [Pt, Pt, Pt, Pt]> = {
  [U]: [[0, 3], [3, 3], [0, 0], [3, 0]],
  [D]: [[0, 0], [3, 0], [0, 3], [3, 3]],
  [R]: [[0, 0], [0, 3], [3, 0], [3, 3]],
  [L]: [[3, 0], [3, 3], [0, 0], [0, 3]],
};

const angleDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

export interface LayoutOptions {
  anchor?: number; // アンカーにする面（findFaces の番号）。省略時は最大面積
  anchorAngle?: number; // 前フレームのアンカーの列方向（ラジアン）。画像の右から 55° 以内なら維持する
}

export function layoutFaces(faces: LatticeFace[], opts: LayoutOptions = {}): PlacedFace[] {
  if (!faces.length) return [];
  const anchorIdx = opts.anchor ?? faces.map((f) => faceArea(f.H)).reduce((bi, a, i, arr) => (a > arr[bi] ? i : bi), 0);
  const anchor = faces[anchorIdx];
  // 列方向が画像の右（+x）に最も近い向き。ただし前フレームの向きが 55° 以内なら維持する
  // （斜め 45° 付近で向きがフレームごとに入れ替わらないように。画像の軸から離れすぎない範囲で）
  let rot = 0;
  let bestDiff = Infinity;
  for (let r = 0; r < 4; r++) {
    const d = angleDiff(colAngle({ H: anchor.H, rot: r }), 0);
    if (d < bestDiff) {
      bestDiff = d;
      rot = r;
    }
  }
  if (opts.anchorAngle !== undefined) {
    for (let r = 0; r < 4; r++) {
      const a = colAngle({ H: anchor.H, rot: r });
      if (angleDiff(a, opts.anchorAngle) < Math.PI / 6 && angleDiff(a, 0) < (55 * Math.PI) / 180) rot = r;
    }
  }
  const placed: PlacedFace[] = [{ slot: F, rot, H: anchor.H, found: anchor.found, latticeIndex: anchorIdx }];
  const inv = invertH(anchor.H);
  const toAnchor = (p: Pt): Pt => {
    const [u, v] = applyH(inv, p[0], p[1]);
    return latticeToSlot(rot, u, v);
  };

  faces.forEach((g, gi) => {
    if (gi === anchorIdx) return;
    const [cx, cy] = toAnchor(applyH(g.H, 1.5, 1.5));
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
    const dx = cx - 1.5;
    const dy = cy - 1.5;
    const slot = Math.abs(dy) > Math.abs(dx) ? (dy < 0 ? U : D) : dx > 0 ? R : L;
    let bestRot = 0;
    let bestScore = -Infinity;
    for (let r = 0; r < 4; r++) {
      const pts = Array.from({ length: 9 }, (_, cell) => toAnchor(cellCenter({ H: g.H, rot: r }, cell)));
      const mx = pts.reduce((s, p) => s + p[0], 0) / 9;
      const my = pts.reduce((s, p) => s + p[1], 0) / 9;
      let score = 0;
      pts.forEach((p, cell) => (score += (p[0] - mx) * ((cell % 3) - 1) + (p[1] - my) * (Math.floor(cell / 3) - 1)));
      if (score > bestScore) {
        bestScore = score;
        bestRot = r;
      }
    }
    // 窓の位置が曖昧なら、アンカーと共有する辺がぴったり重なるずらし方を選ぶ
    // （共有辺上の点は両方の平面に乗るので、アンカー平面への射影でも正確に一致する）
    let H = g.H;
    if (g.alts.length) {
      const [e1, e2, a1, a2] = SHARED_EDGE[slot];
      const edgeError = (Hc: Mat3) => {
        const p1 = toAnchor(slotPoint({ H: Hc, rot: bestRot }, e1[0], e1[1]));
        const p2 = toAnchor(slotPoint({ H: Hc, rot: bestRot }, e2[0], e2[1]));
        return Math.hypot(p1[0] - a1[0], p1[1] - a1[1]) + Math.hypot(p2[0] - a2[0], p2[1] - a2[1]);
      };
      let bestErr = edgeError(H);
      for (const alt of g.alts) {
        const e = edgeError(alt);
        if (e < bestErr - 0.3) {
          bestErr = e;
          H = alt;
        }
      }
    }
    const existing = placed.findIndex((p) => p.slot === slot);
    const entry = { slot, rot: bestRot, H, found: g.found, latticeIndex: gi };
    if (existing < 0) placed.push(entry);
    else if (placed[existing].slot !== F && placed[existing].found < g.found) placed[existing] = entry;
  });
  return placed;
}

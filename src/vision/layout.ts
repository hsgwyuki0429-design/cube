// 面の格子の座標 → 画像。面の座標は x = 列方向・y = 行方向（0〜3。セル (row, col) の中心は (col + 0.5, row + 0.5)）で、
// セルの並びはカメラフレームの規約（CLAUDE.md の展開図フレーム）。rot は格子の回転（ArUco で組み立てた面は 0）
import { type Mat3, type Pt, applyH } from "./homography";

export function slotPoint(face: { H: Mat3; rot: number }, x: number, y: number): Pt {
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

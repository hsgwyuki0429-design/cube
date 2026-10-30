// 再認識: 組み立てた面のうち、マーカーを読めなかったマスだけを切り出して拡大し、二値化の窓を細かく試して読み直す。
// 全体の検出では小さく写った・少しぶれたマーカーが四角の候補にならないことがある。読めたマーカーで面の格子が分かっているので、
// どこを探せばよいかは分かる。読めた ID は、そのマスにあるはずの向き・位置（54 種類はマーカーの ID と向きから面の真ん中が
// 分かる: centerOffset）と合うときだけ使う（合わない読みは捨てて「不明」のまま。無理に決めない）。DOM もカメラも知らない
import { type Mat3, type Pt, applyH, invertH } from "../vision/homography";
import { type StickerScheme, centerOffset, decode, hasIdentity } from "./codes";
import { colorConsistent, readConfidence } from "./cube";
import type { VisibleFace } from "./cube";
import type { ArucoBench, ImageLike } from "./detect";

const PAD = 0.2; // マスの外側にも少し広げて切り出す（マス = 1）
const TARGET = 110; // 拡大した後のマスの大きさ（px）

// 画像の四角形の範囲を拡大して切り出す（双線形）
function crop(img: ImageLike, x0: number, y0: number, w: number, h: number, s: number): ImageLike {
  const cw = Math.max(8, Math.round(w * s));
  const ch = Math.max(8, Math.round(h * s));
  const out = new Uint8ClampedArray(cw * ch * 4);
  const W = img.width;
  const Hh = img.height;
  for (let y = 0; y < ch; y++) {
    const sy = Math.min(Hh - 1.001, Math.max(0, y0 + (y + 0.5) / s - 0.5));
    const iy = Math.floor(sy);
    const fy = sy - iy;
    for (let x = 0; x < cw; x++) {
      const sx = Math.min(W - 1.001, Math.max(0, x0 + (x + 0.5) / s - 0.5));
      const ix = Math.floor(sx);
      const fx = sx - ix;
      const a = (iy * W + ix) * 4;
      const b = a + 4;
      const c = a + W * 4;
      const d = c + 4;
      const o = (y * cw + x) * 4;
      for (let k = 0; k < 3; k++) out[o + k] = (img.data[a + k] * (1 - fx) + img.data[b + k] * fx) * (1 - fy) + (img.data[c + k] * (1 - fx) + img.data[d + k] * fx) * fy;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: cw, height: ch };
}

export interface Reread {
  cell: number;
  id: number;
  face: number; // 色（センターの面）
  sticker: number; // 揃った状態での facelet 番号（12 種類は -1）
  conf: number; // 読みの確からしさ（readConfidence × 読み直した分 REREAD_CONF）
}

// 読み直したマスは、全体の検出で読めなかった（小さい・ぶれている）ので少し弱く
const REREAD_CONF = 0.8;

// face（H: 面の座標 x = 列・y = 行 → 画像）のマス cell を読み直す。読めて辻褄が合えば結果、なければ null
export function rereadCell(bench: ArucoBench, img: ImageLike, H: Mat3, cell: number, scheme: StickerScheme): Reread | null {
  const r = Math.floor(cell / 3);
  const c = cell % 3;
  const corners: Pt[] = [
    [c - PAD, r - PAD],
    [c + 1 + PAD, r - PAD],
    [c + 1 + PAD, r + 1 + PAD],
    [c - PAD, r + 1 + PAD],
  ].map(([x, y]) => applyH(H, x, y));
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(img.width, Math.ceil(Math.max(...xs)));
  const y1 = Math.min(img.height, Math.ceil(Math.max(...ys)));
  if (x1 - x0 < 6 || y1 - y0 < 6) return null;
  const cellPx = Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]) / (1 + 2 * PAD);
  const s = Math.min(4, Math.max(1, TARGET / Math.max(1, cellPx)));
  const sub = crop(img, x0, y0, x1 - x0, y1 - y0, s);
  const Hi = invertH(H);
  for (const m of bench.detect(sub)[0].markers) {
    const pts: Pt[] = [0, 1, 2, 3].map((i) => [x0 + (m.corners[i * 2] + 0.5) / s - 0.5, y0 + (m.corners[i * 2 + 1] + 0.5) / s - 0.5]);
    const q = pts.map(([x, y]) => applyH(Hi, x, y));
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
    const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    if (Math.floor(cx) !== c || Math.floor(cy) !== r) continue;
    const dec = decode(scheme, m.id);
    if (!dec || !colorConsistent(scheme, m.id, m.rgb)) continue;
    if (hasIdentity(scheme)) {
      // マーカーの右・下の向き（面の座標で 90° 単位）から、ID の示す面の真ん中がマス (1, 1) になること
      const ang = Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0]);
      const k = ((Math.round(ang / (Math.PI / 2)) % 4) + 4) % 4;
      const right: [number, number] = [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ][k] as [number, number];
      const down: [number, number] = [-right[1], right[0]];
      const [ox, oy] = centerOffset(dec.sticker);
      if (c + ox * right[0] + oy * down[0] !== 1 || r + ox * right[1] + oy * down[1] !== 1) continue;
    } else if (dec.center !== (cell === 4)) continue;
    return { cell, id: m.id, face: dec.face, sticker: dec.sticker, conf: readConfidence(m.fit) * REREAD_CONF };
  }
  return null;
}

// 面の読めなかったマスを読み直す（focus を先に、全体で budget 個まで）。読めたマスは face.colors / face.ids を書き換え、そのマスの番号を返す
export function rereadFaces(bench: ArucoBench, img: ImageLike, faces: VisibleFace[], scheme: StickerScheme, budget: number, focus: Set<number> = new Set()): Set<number> {
  const todo: { f: VisibleFace; cell: number; pri: number }[] = [];
  for (const f of faces) {
    if (f.partial) continue; // 外枠が推定の面は、マスの位置も確かでない
    for (let cell = 0; cell < 9; cell++) if (f.colors[cell] < 0) todo.push({ f, cell, pri: focus.has(f.slot * 9 + cell) ? 0 : 1 });
  }
  todo.sort((a, b) => a.pri - b.pri);
  const got = new Set<number>();
  for (const { f, cell } of todo.slice(0, budget)) {
    const r = rereadCell(bench, img, f.H, cell, scheme);
    if (!r) continue;
    f.colors[cell] = r.face;
    f.ids[cell] = r.sticker;
    f.conf[cell] = r.conf;
    got.add(f.slot * 9 + cell);
  }
  return got;
}

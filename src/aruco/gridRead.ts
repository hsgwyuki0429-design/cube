// 格子で読む: 組み立てた面の格子（面の座標 → 画像の射影変換）が分かっていれば、ステッカーの中のマーカーの位置も分かる。
// OpenCV で四角の候補を探さずに、マーカーのマスの中心の明暗を直接読んで ID を決める（4 個の配置は、同じ ID・同じ向きの 4 個を
// まとめて読む。指で隠れたマーカーは枠が黒くないので外す）。格子は少しずれていることがある（ピースの段差・前のフレームの格子）ので、
// マスごとに 1 マス分ほどの範囲で位置と大きさを合わせてから読む（枠の点が暗く、マーカーの間の点が明るい所）。回している途中の層の
// マスは向きが合わないので読めない（読めないままにする）。1 マス 0.1〜0.3ms（山登り）・0.3〜0.7ms（範囲全体）。OpenCV の検出は
// 1 フレーム 20〜60ms。3×3 の符号（unique54・aruco12）で、マーカーの間にステッカーの色が見える配置（4 個: quad-half）向け
// （1 個の配置はマーカーの間がないので読めない: null）。DOM もカメラも知らない
import { type Mat3, type Pt, applyH, invertH } from "../vision/homography";
import { median } from "../lib/util";
import { type VisibleFace, cellH, readConfidence } from "./cube";
import { type StickerScheme, centerOffset, codesOf, decode } from "./codes";
import type { ImageLike, Marker } from "./detect";
import type { StickerDesign } from "./design";

export interface GridRead {
  cell: number;
  id: number;
  face: number; // 色（センターの面）
  sticker: number; // 揃った状態での facelet 番号
  fit: number; // 読めたマーカーのマス（枠を含む）のうち、明暗が読んだ符号どおりの割合
  markers: Marker[]; // 読めたマーカー（角は画像の座標、左上から時計回り = マーカーの上辺の向き）
  offset: Pt; // 合わせた位置（面の座標）
}

export interface GridOptions {
  reach: number; // 位置を合わせる範囲（面の座標、片側）
  climb?: boolean; // 予測した位置から山登りで合わせる（前のフレームの格子から追うとき。既定は範囲全体を 0.04 刻みで探す）
  minContrast: number; // 明るい点と黒い枠の差（max(R,G,B)）の下限
  minFit: number;
  step?: number; // 範囲全体を探すときの刻み（既定 0.04）
}

export const DEFAULT_GRID: GridOptions = { reach: 0.12, minContrast: 35, minFit: 0.92 };

// 符号を時計回りに 90°（ビット r*n+c → c*n + (n-1-r)。src/aruco/detect.ts と同じ）
function rotCode(code: number, n: number): number {
  let out = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if ((code >> (r * n + c)) & 1) out |= 1 << (c * n + (n - 1 - r));
  return out;
}

// 符号（回した 4 通り）→ ID と回した回数
const tables = new Map<StickerScheme, Map<number, { id: number; rot: number }>>();
function codeTable(scheme: StickerScheme): Map<number, { id: number; rot: number }> {
  let t = tables.get(scheme);
  if (!t) {
    t = new Map();
    codesOf(scheme).forEach((code, id) => {
      let x = code;
      for (let rot = 0; rot < 4; rot++, x = rotCode(x, 3)) if (!t!.has(x)) t!.set(x, { id, rot });
    });
    tables.set(scheme, t);
  }
  return t;
}

// ステッカーの中の点（u, v: 0〜1、面の軸にそろえた向き）の、マスの中の面の座標
const MODULES = 5; // 3×3 の符号 + 枠
const SCALES = [0.92, 1, 1.08]; // 位置を合わせるときに試す大きさ（ステッカーの辺の倍率）
const CLEAR = 0.2; // 符号のマスの明るさの thr からの差（明るい点と枠の差 = 1）がこれ以上ならはっきりしている（食い違いの判定）
// 読めたマーカーの平均の明るさの thr からの差の下限。実物の動画（iPhone・1080p を 1280 に縮めた）で、0.12 → 0.08 と内側の点（0.22 → 0.15）で
// 読めたマスが 77 → 108（検出で読めたマス 153 のうち）・違う ID 0。合成でも読めないマス 1660 → 709・違う ID 0
const JOINT_CLEAR = 0.08;
const SUB = 0.15; // 符号のマスの中で読む 2×2 点の、真ん中からのずれ（マス = 1。ぶれた縁の色を拾わないように内側）

interface Layout {
  // 面の座標での点（マスの真ん中を原点、ステッカーの辺 = 1 にする前）: 各マーカーの 5×5 マスの中心、マーカーの間（ステッカーの色）
  border: Pt[]; // 4 × 16（マーカーごとに 16 個ずつ）
  inner: Pt[]; // 4 × 9 × 4（マーカーごと・マスごとに 2×2 の点）
  gap: Pt[];
  squares: Pt[][]; // マーカーの四角（左上から時計回り、面の軸にそろえた向き）
}

function layoutOf(design: StickerDesign): Layout {
  const m = design.side / MODULES;
  const border: Pt[] = [];
  const inner: Pt[] = [];
  const squares: Pt[][] = [];
  for (const [ax, ay] of design.at) {
    for (let i = 0; i < MODULES; i++)
      for (let j = 0; j < MODULES; j++) {
        const u = ax - 0.5 + (j - 2) * m;
        const v = ay - 0.5 + (i - 2) * m;
        if (i === 0 || j === 0 || i === MODULES - 1 || j === MODULES - 1) border.push([u, v]);
        else for (const dy of [-SUB, SUB]) for (const dx of [-SUB, SUB]) inner.push([u + dx * m, v + dy * m]);
      }
    const h = design.side / 2;
    squares.push([
      [ax - 0.5 - h, ay - 0.5 - h],
      [ax - 0.5 + h, ay - 0.5 - h],
      [ax - 0.5 + h, ay - 0.5 + h],
      [ax - 0.5 - h, ay - 0.5 + h],
    ]);
  }
  // マーカーの間（ステッカーの色）: マーカーの外側の 0.6 マス〜の点。ほかのマーカーの四角の中・ステッカーの外に出る点は使わない
  const gap: Pt[] = [];
  const insideAny = (u: number, v: number, pad: number) => design.at.some(([ax, ay]) => Math.abs(u - (ax - 0.5)) < design.side / 2 + pad && Math.abs(v - (ay - 0.5)) < design.side / 2 + pad);
  for (let i = 0; i <= 16; i++)
    for (let j = 0; j <= 16; j++) {
      const u = -0.42 + (0.84 * j) / 16;
      const v = -0.42 + (0.84 * i) / 16;
      if (!insideAny(u, v, 0.4 * m)) gap.push([u, v]);
    }
  return { border, inner, gap, squares };
}
const layouts = new WeakMap<StickerDesign, Layout>();

// H（面の座標 → 画像）のマス cell を読む。sticker: ステッカーの辺（面の座標）。prior: 先に試す位置のずれ（前のフレームで合わせた位置）
export function gridReadCell(img: ImageLike, H: Mat3, cell: number, scheme: StickerScheme, design: StickerDesign, sticker: number, o: GridOptions = DEFAULT_GRID, prior: Pt = [0, 0], scales: number[] = SCALES): GridRead | null {
  let L = layouts.get(design);
  if (!L) layouts.set(design, (L = layoutOf(design)));
  const r = Math.floor(cell / 3);
  const c = cell % 3;
  const cx = c + 0.5;
  const cy = r + 0.5;
  // マスの中では射影変換を 1 次（アフィン）で近似する: 点 p（ステッカーの座標）の画像の位置 = c0 + k·A(p) + J·(dx, dy)。
  // k（大きさ）と (dx, dy)（面の座標のずれ）を合わせる。大きさはマスごとに ±8% ほどずれる（面の格子は 9 マスの平均、マーカーの辺も
  // 面ごとに 1 つの値）ので、大きさも探す
  const c0 = applyH(H, cx, cy);
  const ex = applyH(H, cx + 0.01, cy);
  const ey = applyH(H, cx, cy + 0.01);
  const J = [(ex[0] - c0[0]) / 0.01, (ey[0] - c0[0]) / 0.01, (ex[1] - c0[1]) / 0.01, (ey[1] - c0[1]) / 0.01];
  const pitch = Math.sqrt(Math.abs(J[0] * J[3] - J[1] * J[2])); // 面の座標 1 の画素（面積の平方根）
  if (pitch * sticker * design.side < 9) return null; // マーカーが小さすぎる（1 マス 2 画素未満）
  const W = img.width;
  const Hh = img.height;
  const data = img.data;
  const pack = (pts: Pt[]) => {
    const a = new Float32Array(pts.length * 2);
    pts.forEach(([u, v], i) => {
      a[i * 2] = (J[0] * u + J[1] * v) * sticker;
      a[i * 2 + 1] = (J[2] * u + J[3] * v) * sticker;
    });
    return a;
  };
  const bA = pack(L.border);
  const gA = pack(L.gap);
  const nb = L.border.length;
  const ng = L.gap.length;
  const bv = new Float32Array(nb);
  const gv = new Float32Array(ng);
  // 点の明るさ（max(R,G,B)）を out に読み、合計を返す。画像の外に出たら -1
  const read = (A: Float32Array, n: number, k: number, ox: number, oy: number, out: Float32Array): number => {
    let sum = 0;
    for (let q = 0; q < n; q++) {
      const xi = Math.round(c0[0] + ox + k * A[q * 2]);
      const yi = Math.round(c0[1] + oy + k * A[q * 2 + 1]);
      if (xi < 0 || yi < 0 || xi >= W || yi >= Hh) return -1;
      const i = (yi * W + xi) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const v = r > g ? (r > b ? r : b) : g > b ? g : b;
      out[q] = v;
      sum += v;
    }
    return sum;
  };
  // 枠は暗く、マーカーの間（ステッカーの色）は明るいほどよい
  const score = (k: number, dx: number, dy: number): number => {
    const ox = J[0] * dx + J[1] * dy;
    const oy = J[2] * dx + J[3] * dy;
    const sb = read(bA, nb, k, ox, oy, bv);
    if (sb < 0) return -Infinity;
    const sg = read(gA, ng, k, ox, oy, gv);
    if (sg < 0) return -Infinity;
    return sg / ng - sb / nb;
  };
  let best = { k: 1, dx: prior[0], dy: prior[1], s: score(1, prior[0], prior[1]) };
  if (o.climb) {
    // 山登り（前のフレームの格子から追う）: 予測した位置から 0.04 刻みで、良くなる方へ動かす（範囲は reach まで）
    for (let n = 0; n < 6; n++) {
      const b0 = best;
      for (let dy = -0.04; dy <= 0.04 + 1e-9; dy += 0.04)
        for (let dx = -0.04; dx <= 0.04 + 1e-9; dx += 0.04) {
          if (!dx && !dy) continue;
          const x = b0.dx + dx;
          const y = b0.dy + dy;
          if (Math.abs(x - prior[0]) > o.reach + 1e-9 || Math.abs(y - prior[1]) > o.reach + 1e-9) continue;
          const sc = score(1, x, y);
          if (sc > best.s) best = { k: 1, dx: x, dy: y, s: sc };
        }
      if (best === b0) break;
    }
  } else {
    const step0 = o.step ?? 0.04;
    for (const k of scales)
      for (let dy = -o.reach; dy <= o.reach + 1e-9; dy += step0)
        for (let dx = -o.reach; dx <= o.reach + 1e-9; dx += step0) {
          const sc = score(k, prior[0] + dx, prior[1] + dy);
          if (sc > best.s) best = { k, dx: prior[0] + dx, dy: prior[1] + dy, s: sc };
        }
  }
  // 細かく: ずれ（8 方向）と大きさ（2 通り）を交互に
  for (const [step, ks] of [
    [0.02, 0.04],
    [0.01, 0.02],
  ]) {
    const b0 = best;
    for (let dy = -step; dy <= step + 1e-9; dy += step)
      for (let dx = -step; dx <= step + 1e-9; dx += step) {
        if (!dx && !dy) continue;
        const sc = score(b0.k, b0.dx + dx, b0.dy + dy);
        if (sc > best.s) best = { k: b0.k, dx: b0.dx + dx, dy: b0.dy + dy, s: sc };
      }
    const b1 = best;
    for (const dk of [-ks, ks]) {
      const sc = score(b1.k + dk, b1.dx, b1.dy);
      if (sc > best.s) best = { k: b1.k + dk, dx: b1.dx, dy: b1.dy, s: sc };
    }
  }
  if (!(best.s >= o.minContrast)) return null;
  // 合わせた位置で読む
  score(best.k, best.dx, best.dy);
  const sortedG = Array.from(gv).sort((a, b) => a - b);
  const light = sortedG[Math.floor(ng * 0.5)];
  const sortedB = Array.from(bv).sort((a, b) => a - b);
  const dark = sortedB[Math.floor(nb * 0.25)];
  if (light - dark < o.minContrast) return null;
  const thr = (light + dark) / 2;
  const ox = J[0] * best.dx + J[1] * best.dy;
  const oy = J[2] * best.dx + J[3] * best.dy;
  const markers = design.at.length;
  const perB = nb / markers;
  const iA = pack(L.inner);
  const iv = new Float32Array(L.inner.length);
  if (read(iA, L.inner.length, best.k, ox, oy, iv) < 0) return null;
  const perI = L.inner.length / markers; // 9 マス × 4 点
  // マーカーごと: 枠が黒いか（指で隠れていないか）、符号のマスの明るさ（thr からの差）
  const valid: boolean[] = [];
  const bits: Float32Array[] = [];
  for (let m = 0; m < markers; m++) {
    let darkN = 0;
    for (let q = 0; q < perB; q++) if (bv[m * perB + q] < thr) darkN++;
    valid.push(darkN >= perB - 2);
    const b = new Float32Array(9);
    for (let cellI = 0; cellI < 9; cellI++) {
      const at = m * perI + cellI * 4;
      b[cellI] = ((iv[at] + iv[at + 1] + iv[at + 2] + iv[at + 3]) / 4 - thr) / (light - dark);
    }
    bits.push(b);
  }
  if (!valid.some(Boolean)) return null;
  // 符号のマスごとに、読めたマーカーの明るさ（thr からの差）を平均して決める。どのマスも平均が JOINT_CLEAR 以上離れていること
  // （マスの縁にかかった点・ぶれは thr の近くになり、2 ビットの読み違いで別の ID になる: 距離 2 の符号がある）。以前は 1 個の
  // マーカーのどのマスも CLEAR 以上離れていることを求めていて、実物の動画（ぶれ・照明）では読めたはずのマスの 6 割を捨てていた
  let code = 0;
  let nValid = 0;
  for (let k = 0; k < markers; k++) if (valid[k]) nValid++;
  for (let i = 0; i < 9; i++) {
    let sum = 0;
    for (let k = 0; k < markers; k++) if (valid[k]) sum += bits[k][i];
    const mean = sum / nValid;
    if (Math.abs(mean) < JOINT_CLEAR) return null;
    if (mean > 0) code |= 1 << i;
  }
  // ほかの（はっきりしないマスのある）マーカーも、はっきりしたマスは食い違わないこと
  for (let k = 0; k < markers; k++) if (valid[k] && bits[k].some((v, i) => Math.abs(v) >= CLEAR && v > 0 !== ((code >> i) & 1) > 0)) return null;
  const hit = codeTable(scheme).get(code);
  if (!hit) return null;
  const dec = decode(scheme, hit.id);
  if (!dec) return null;
  // 読めたマーカーのマス（枠 16 + 符号 9）の明暗が符号どおりの割合
  let agree = 0;
  let total = 0;
  for (let k = 0; k < markers; k++) {
    if (!valid[k]) continue;
    for (let q = 0; q < perB; q++) if (bv[k * perB + q] < thr) agree++;
    total += perB;
    for (let i = 0; i < 9; i++) if (bits[k][i] > 0 === ((code >> i) & 1) > 0) agree++;
    total += 9;
  }
  const fit = agree / total;
  if (fit < o.minFit) return null;
  // 向き: 符号が時計回りに rot 回だけ回って写っている → マーカーの左上は面の軸にそろえた四角の角 rot。
  // ID の示す面の真ん中（centerOffset: マーカーの右・下の向き）が、マス (1, 1) になること（読み違い・回している途中の層を捨てる）
  const right: Pt = ([
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ] as Pt[])[hit.rot];
  const down: Pt = [-right[1], right[0]];
  const [cxo, cyo] = centerOffset(dec.sticker);
  if (c + cxo * right[0] + cyo * down[0] !== 1 || r + cxo * right[1] + cyo * down[1] !== 1) return null;
  // マーカー: 角（読んだ向きの左上から時計回り）・明るいマスの色
  const out: Marker[] = [];
  const rgbSum = [0, 0, 0];
  let rgbN = 0;
  for (let q = 0; q < ng; q++) {
    const xi = Math.round(c0[0] + ox + best.k * gA[q * 2]);
    const yi = Math.round(c0[1] + oy + best.k * gA[q * 2 + 1]);
    const kk = (yi * img.width + xi) * 4;
    rgbSum[0] += img.data[kk];
    rgbSum[1] += img.data[kk + 1];
    rgbSum[2] += img.data[kk + 2];
    rgbN++;
  }
  const rgb: [number, number, number] = [Math.round(rgbSum[0] / rgbN), Math.round(rgbSum[1] / rgbN), Math.round(rgbSum[2] / rgbN)];
  for (let k = 0; k < markers; k++) {
    if (!valid[k]) continue;
    const sq = L.squares[k];
    const corners: number[] = [];
    for (let i = 0; i < 4; i++) {
      const [u, v] = sq[(i + hit.rot) % 4];
      const p = applyH(H, cx + u * sticker * best.k + best.dx, cy + v * sticker * best.k + best.dy);
      corners.push(Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10);
    }
    let side = 0;
    for (let i = 0; i < 4; i++) side += Math.hypot(corners[((i + 1) % 4) * 2] - corners[i * 2], corners[((i + 1) % 4) * 2 + 1] - corners[i * 2 + 1]) / 4;
    const angle = (Math.atan2(corners[3] - corners[1], corners[2] - corners[0]) * 180) / Math.PI;
    let mk = 0;
    for (let q = 0; q < perB; q++) if (bv[k * perB + q] < thr) mk++;
    for (let i = 0; i < 9; i++) if (bits[k][i] > 0 === ((code >> i) & 1) > 0) mk++;
    out.push({ id: hit.id, corners, side, angle, rgb, contrastGray: Math.round(light - dark), contrastMax: Math.round(light - dark), fit: mk / (perB + 9) });
  }
  return { cell, id: hit.id, face: dec.face, sticker: dec.sticker, fit, markers: out, offset: [best.dx, best.dy] };
}

// 色の確かめ（同じフレームの色の仲間と比べる。src/aruco/cube.ts の frameColorFilter と同じ考え）: 写った色味（最大のチャンネルで
// 割った RGB）が、読んだ ID の色の仲間よりほかの色の仲間にずっと近ければ読み違い（実物の動画で、白の面のマスを緑のステッカーと
// 読んだことがあった）。照明で色がずれても同じ色のステッカーは同じようにずれるので、色そのものではなく仲間と比べる
export type ColorRefs = Map<number, number[]>; // 面（色）→ 色味の中央値
const chroma = (rgb: readonly number[]) => {
  const m = Math.max(rgb[0], rgb[1], rgb[2], 1);
  return [rgb[0] / m, rgb[1] / m, rgb[2] / m];
};
export function colorRefsOf(markers: Marker[], scheme: StickerScheme): ColorRefs {
  const groups = new Map<number, number[][]>();
  for (const m of markers) {
    const d = decode(scheme, m.id);
    if (!d) continue;
    groups.set(d.face, [...(groups.get(d.face) ?? []), chroma(m.rgb)]);
  }
  const out: ColorRefs = new Map();
  for (const [face, xs] of groups) if (xs.length >= 2) out.set(face, [0, 1, 2].map((k) => median(xs.map((x) => x[k]))));
  return out;
}
export function colorFits(refs: ColorRefs | null, face: number, rgb: readonly number[]): boolean {
  if (!refs?.size) return true;
  const x = chroma(rgb);
  const dist = (a: number[]) => Math.hypot(x[0] - a[0], x[1] - a[1], x[2] - a[2]);
  const own = refs.get(face);
  let other = Infinity;
  for (const [f, r] of refs) if (f !== face) other = Math.min(other, dist(r));
  if (!own) return other > 0.1;
  return !(other < 0.15 && other < dist(own) * 0.5);
}

// 格子で読んだマスの読みの確からしさ（OpenCV で四角として見つけたマーカーより少し弱く）
const GRID_CONF = 0.9;

// 面ごとのステッカーの辺（面の座標）: 面のマスに読めたマーカーの角を面の座標に戻した辺の中央値。なければ仮想のマーカーの辺から
export function stickerSide(f: VisibleFace, markers: Marker[], design: StickerDesign): number | null {
  const cellOf = new Map<number, number>();
  f.ids.forEach((id, cell) => id >= 0 && cellOf.set(id, cell));
  const sides: number[] = [];
  for (const m of markers) {
    const cell = cellOf.get(m.id);
    if (cell === undefined) continue;
    const Hi = invertH(cellH(f, cell));
    const q = [0, 1, 2, 3].map((i) => applyH(Hi, m.corners[i * 2], m.corners[i * 2 + 1]));
    let side = 0;
    for (let i = 0; i < 4; i++) side += Math.hypot(q[(i + 1) % 4][0] - q[i][0], q[(i + 1) % 4][1] - q[i][1]) / 4;
    sides.push(side / design.side);
  }
  if (sides.length) return median(sides);
  return f.marker ? f.marker / 0.84 : null;
}

// 組み立てた面（3×3 の面だけ）の読めなかったマスを格子で読む。読めたマスは face.colors / ids / conf を書き換え、読めたマーカーを返す
// （次のフレームで追う・手の時刻のマーカーのずれに使う）。cells: 読むマス（slot * 9 + cell。省略時は読めなかったマス全部）
export function gridReadFaces(img: ImageLike, faces: VisibleFace[], markers: Marker[], scheme: StickerScheme, design: StickerDesign, cells?: Set<number>): Marker[] {
  const out: Marker[] = [];
  const refs = colorRefsOf(markers, scheme);
  for (const f of faces) {
    if (f.partial) continue;
    let S: number | null | undefined;
    for (let cell = 0; cell < 9; cell++) {
      if (f.colors[cell] >= 0 || (cells && !cells.has(f.slot * 9 + cell))) continue;
      if (S === undefined) S = stickerSide(f, markers, design);
      if (!S) break;
      const g = gridReadCell(img, cellH(f, cell), cell, scheme, design, S, DEFAULT_GRID, [0, 0], MEASURED);
      if (!g || !colorFits(refs, g.face, g.markers[0].rgb)) continue;
      f.colors[cell] = g.face;
      f.ids[cell] = g.sticker;
      f.conf[cell] = readConfidence(g.fit) * GRID_CONF;
      out.push(...g.markers);
    }
  }
  return out;
}
const MEASURED = [1]; // 辺を面のマーカーから測ったとき（大きさは細かい合わせで ±6% まで動かす）

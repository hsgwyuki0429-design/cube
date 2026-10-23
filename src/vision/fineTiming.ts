// 精密解析での、タイムの両端（最初の手の回し始め・最後の手の回し終わり）の詰め。
//
// 色の読み（セル中央の代表色）は層が 20〜30° 回るまで変わらないので、開始は遅く・終了は早く出る。
// ここでは面ごとに格子で正規化した小さな画像（パッチ）をフレームごとに残しておき、回した層のセルの画素が
// 静止時から変わり始めた（変わり終えた）フレームを探す。10° 以下の動きでも縁がずれて差が出る。
// キューブ全体の動きは格子で正規化して消し、残る当てはめの揺れは回していないセルの差を引いて打ち消す。
import { moveFace } from "../cube/model";
import { cellInLayer, cellOnFace } from "../track/timing";
import type { DecodedMove } from "../track/types";
import type { Mat3 } from "./homography";
import { slotPoint } from "./layout";
import type { Lab } from "./color";
import type { PixelSource } from "./sampler";

// キューブの色らしいか（指・手が乗ったセルは、どの色からも遠い）
function cubeLike(lab: Lab | undefined, refs: Lab[] | undefined): boolean {
  if (!lab || !refs) return true;
  let best = Infinity;
  for (const r of refs) best = Math.min(best, Math.hypot((lab[0] - r[0]) / 2, lab[1] - r[1], lab[2] - r[2]));
  return best < 30;
}

export const CELL_PX = 10;
// 面の外側も少し含める: 回り始めた層の角は面の輪郭からはみ出し、反対側では隙間が開く。
// 1色の列（揃った面など）は列の中を横にずれても画素が変わらないので、動きが最初に見えるのはこの縁
export const MARGIN = 0.35;
const S = Math.round((3 + 2 * MARGIN) * CELL_PX);
// パッチの各画素が属するセル（面の外側は最も近いセル）
const PIXEL_CELL = (() => {
  const out = new Uint8Array(S * S);
  for (let i = 0; i < S; i++)
    for (let j = 0; j < S; j++) {
      const x = (j + 0.5) / CELL_PX - MARGIN;
      const y = (i + 0.5) / CELL_PX - MARGIN;
      out[i * S + j] = Math.min(2, Math.max(0, Math.floor(y))) * 3 + Math.min(2, Math.max(0, Math.floor(x)));
    }
  return out;
})();

export interface FacePatch {
  slot: number;
  labs?: Lab[]; // セルの色（指が乗ったセルを除くのに使う）
  rgb: Uint8Array; // S×S×3（スロットの向き: 列 = x、行 = y。面の外側 MARGIN を含む）
  masked: boolean[];
}

export interface PatchFrame {
  t: number;
  faces: FacePatch[];
}

export function facePatch(img: PixelSource, face: { slot: number; H: Mat3; rot: number; masked: boolean[]; labs?: Lab[] }): FacePatch {
  const rgb = new Uint8Array(S * S * 3);
  const { width: w, height: h, data } = img;
  for (let i = 0; i < S; i++) {
    for (let j = 0; j < S; j++) {
      const [px, py] = slotPoint(face, (j + 0.5) / CELL_PX - MARGIN, (i + 0.5) / CELL_PX - MARGIN);
      const o = (i * S + j) * 3;
      if (!(px >= 0 && py >= 0 && px < w - 1 && py < h - 1)) continue;
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const fx = px - x0;
      const fy = py - y0;
      const k00 = (y0 * w + x0) * 4;
      const k10 = k00 + 4;
      const k01 = k00 + w * 4;
      const k11 = k01 + 4;
      for (let c = 0; c < 3; c++) {
        const top = data[k00 + c] * (1 - fx) + data[k10 + c] * fx;
        const bot = data[k01 + c] * (1 - fx) + data[k11 + c] * fx;
        rgb[o + c] = top * (1 - fy) + bot * fy;
      }
    }
  }
  return { slot: face.slot, rgb, masked: [...face.masked], labs: face.labs?.map((l) => [...l] as Lab) };
}

// セルごとの画素の差の合計と画素数（RGB の絶対差。面の外側の縁を含む）
function cellDiffs(a: FacePatch, b: FacePatch): { sum: Float64Array; n: Uint32Array } {
  const sum = new Float64Array(9);
  const n = new Uint32Array(9);
  for (let p = 0; p < S * S; p++) {
    const o = p * 3;
    const c = PIXEL_CELL[p];
    sum[c] += Math.abs(a.rgb[o] - b.rgb[o]) + Math.abs(a.rgb[o + 1] - b.rgb[o + 1]) + Math.abs(a.rgb[o + 2] - b.rgb[o + 2]);
    n[c] += 3;
  }
  return { sum, n };
}

// 中央のセルの中だけの差（別の面が来ていないかの確認）
function centerDiff(a: FacePatch, b: FacePatch): number {
  const lo = Math.round((1 + MARGIN) * CELL_PX);
  const hi = Math.round((2 + MARGIN) * CELL_PX);
  let sum = 0;
  let n = 0;
  for (let i = lo; i < hi; i++)
    for (let j = lo; j < hi; j++) {
      const o = (i * S + j) * 3;
      sum += Math.abs(a.rgb[o] - b.rgb[o]) + Math.abs(a.rgb[o + 1] - b.rgb[o + 1]) + Math.abs(a.rgb[o + 2] - b.rgb[o + 2]);
      n += 3;
    }
  return n ? sum / n : 0;
}

// base と f を比べた「回した層だけの動き」: 層の側面のセル（と外側の縁）の差 − 回していないセルの差。
// 比べられなければ null
export function layerMotion(base: PatchFrame, f: PatchFrame, orient: number, face: number, refs?: Lab[]): number | null {
  let layer = 0;
  let nLayer = 0;
  let still = 0;
  let nStill = 0;
  let layerCells = 0;
  for (const a of f.faces) {
    const b = base.faces.find((x) => x.slot === a.slot);
    if (!b) continue;
    // 中央のセルが大きく違えば別の面が来ている（持ち替え）ので比べない
    if (centerDiff(a, b) > 40) continue;
    const d = cellDiffs(a, b);
    for (let cell = 0; cell < 9; cell++) {
      if (a.masked[cell] || b.masked[cell] || cellOnFace(orient, a.slot, cell, face)) continue;
      // 指が乗っているセル（どちらかのフレームでキューブの色でない）は使わない。指の動きを層の動きと取り違えないように
      if (!cubeLike(a.labs?.[cell], refs) || !cubeLike(b.labs?.[cell], refs)) continue;
      if (cellInLayer(orient, a.slot, cell, face)) {
        layer += d.sum[cell];
        nLayer += d.n[cell];
        layerCells++;
      } else {
        still += d.sum[cell];
        nStill += d.n[cell];
      }
    }
  }
  if (layerCells < 2) return null;
  return layer / nLayer - (nStill ? still / nStill : 0);
}

function firstAfter(frames: PatchFrame[], t: number): number {
  let lo = 0;
  let hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t > t) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

const MIN_SIGNAL = 6; // 回転途中の差がこれより小さければ（見えにくい層）詰めない
const FRACTION = 0.08; // 回転途中の差のこの割合を超えたら動いている
const BASE_GAP_MS = 80; // 基準の静止フレームを、色の読みの開始・終了からこれだけ離す（近すぎると動き始めを含み、遠すぎるとキューブ全体の動きが混ざる）

function noiseFloor(frames: PatchFrame[], base: PatchFrame, from: number, to: number, m: DecodedMove, refs?: Lab[]): number {
  const face = moveFace(m.move);
  const v: number[] = [];
  for (const f of frames) {
    if (f === base || f.t < from || f.t > to) continue;
    const x = layerMotion(base, f, m.orient, face, refs);
    if (x !== null) v.push(Math.abs(x));
  }
  v.sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) * 0.9)] : 0;
}

// 回し始めを詰める: coarse は色の読みから求めた開始（静止フレームと動き出しのフレームの中間）
export function refineStart(frames: PatchFrame[], m: DecodedMove, coarse: number, refs?: Lab[]): number | null {
  const face = moveFace(m.move);
  const k = firstAfter(frames, coarse); // 色の読みで動き出したフレーム
  if (k <= 0 || k >= frames.length) return null;
  // 基準: 少し前の静止フレーム
  let b = k - 1;
  while (b > 0 && frames[b].t > coarse - BASE_GAP_MS) b--;
  const base = frames[b];
  // 回転がはっきり進んだところ（色の読みで動き出したフレームか、その次）の差を基準の大きさにする
  const ref = Math.max(layerMotion(base, frames[k], m.orient, face, refs) ?? 0, k + 1 < frames.length ? (layerMotion(base, frames[k + 1], m.orient, face, refs) ?? 0) : 0);
  if (ref < MIN_SIGNAL) return null;
  // 雑音（手の中でキューブ全体が動く・映り込みの変化）は基準から離れるほど大きいので、調べるフレームと同じだけ離れた範囲で測る
  const span = Math.max(60, frames[k].t - base.t);
  const tau = Math.max(FRACTION * ref, noiseFloor(frames, base, base.t - span, base.t, m, refs) * 2.5, 2.5);
  if (tau >= ref) return null;
  // k から遡って、差がしきい値を超え続けている最初のフレーム（比べられないフレームを挟んだら諦める）
  let j = k;
  for (;;) {
    if (j - 1 <= b) return null;
    const v = layerMotion(base, frames[j - 1], m.orient, face, refs);
    if (v === null) return null;
    if (v <= tau) break;
    j--;
  }
  const start = (frames[j - 1].t + frames[j].t) / 2;
  // 色の読みより遅くはならず、早くても 3 フレームまで（それ以上は別の動きを拾っている）
  if (start > coarse + 1 || frames[k].t - start > 3.5 * (frames[k].t - frames[k - 1].t)) return null;
  return start;
}

// 回し終わりを詰める: coarse は色の読みから求めた終了（動いていたフレームと止まったフレームの中間）
export function refineEnd(frames: PatchFrame[], m: DecodedMove, coarse: number, refs?: Lab[]): number | null {
  const face = moveFace(m.move);
  const e = firstAfter(frames, coarse); // 色の読みで止まったフレーム
  if (e <= 1 || e >= frames.length) return null;
  // 基準: 少し後の静止フレーム
  let b = e;
  while (b + 1 < frames.length && frames[b].t < coarse + BASE_GAP_MS) b++;
  if (b === e || frames[b].t < coarse + BASE_GAP_MS / 2) return null;
  const base = frames[b];
  // 回転の途中（止まる 1〜3 フレーム前）の差を基準の大きさにする
  let ref = 0;
  for (let j = Math.max(0, e - 3); j < e; j++) ref = Math.max(ref, layerMotion(base, frames[j], m.orient, face, refs) ?? 0);
  if (ref < MIN_SIGNAL) return null;
  const span = Math.max(60, base.t - frames[Math.max(0, e - 3)].t);
  const tau = Math.max(FRACTION * ref, noiseFloor(frames, base, base.t, base.t + span, m, refs) * 2.5, 2.5);
  if (tau >= ref) return null;
  // 止まる前のフレームから進んで、差がしきい値を下回る直前のフレーム（比べられないフレームを挟んだら諦める）
  let j = -1;
  for (let i = Math.max(0, e - 3); i < b; i++) {
    const v = layerMotion(base, frames[i], m.orient, face, refs);
    if (v === null) {
      if (j >= 0) return null;
      continue;
    }
    if (v > tau) j = i;
    else if (j >= 0) break;
  }
  if (j < 0 || j + 1 > b) return null;
  if (j + 1 < b && layerMotion(base, frames[j + 1], m.orient, face, refs) === null) return null;
  const end = (frames[j].t + frames[j + 1].t) / 2;
  // 色の読みより早くはならず、遅くても 3 フレームまで
  if (end < coarse - 1 || end - frames[e - 1].t > 3.5 * (frames[e].t - frames[e - 1].t)) return null;
  return end;
}

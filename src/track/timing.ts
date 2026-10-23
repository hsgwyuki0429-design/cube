// 手の正確な開始・終了時刻をフレームの記録から求める。
//
// 観測（色の並びが変わったこと）は回転の途中（約45°）で起きるので、そのままでは開始は遅く、終了は早く出る。
// ここでは回した層のステッカーだけを見て、
//   開始 = その層が止まっていた最後のフレームと、次のフレームの中間
//   終了 = 回転後に再び止まった最初のフレームと、その前のフレームの中間
// とする（誤差はフレーム間隔の半分程度）。「止まっている」= 層のセルがすべて読めて、セル内の色のばらつきが小さい
// （回転中はサンプル点がステッカーの隙間にかかり、ばらつきが急に大きくなる）。手で隠れたセルは使わない。
import { NORMAL, VIEW, faceletGeometry, moveFace } from "../cube/model";
import type { Lab } from "../vision/color";
import type { DecodedMove } from "./types";

export interface LoggedFace {
  slot: number;
  labs: Lab[];
  valid: boolean[];
  spread?: number[];
  masked?: boolean[]; // 手で隠れている（判定に使わない）
}

export interface LoggedFrame {
  t: number;
  faces: LoggedFace[];
}

export interface TimingOptions {
  restSpread: number; // これ以下のばらつきなら止まっている
  onsetDelta: number; // 静止時からこれ以上色が変わったら動き出した
  searchMs: number; // 観測の前後をどこまで探すか
}

export const DEFAULT_TIMING: TimingOptions = { restSpread: 22, onsetDelta: 9, searchMs: 450 };

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// 姿勢 o のとき、カメラの面 slot のセル cell が、面 face そのもののステッカーか（その面を回すと面ごと回る）
export function cellOnFace(o: number, slot: number, cell: number, face: number): boolean {
  return dot(faceletGeometry(VIEW[(o * 6 + slot) * 9 + cell]).normal, NORMAL[face]) === 1;
}

// 姿勢 o のとき、カメラの面 slot のセル cell が、キューブ固定の面 face の層の「側面」のステッカーか。
// 回している面そのもののステッカーは面ごと回るだけで、格子の検出が追従してしまい動きが見えないので使わない
const inLayer = new Map<number, boolean>();
export function cellInLayer(o: number, slot: number, cell: number, face: number): boolean {
  const key = ((o * 6 + slot) * 9 + cell) * 6 + face;
  let v = inLayer.get(key);
  if (v === undefined) {
    const { pos, normal } = faceletGeometry(VIEW[(o * 6 + slot) * 9 + cell]);
    v = dot(pos, NORMAL[face]) === 1 && dot(normal, NORMAL[face]) !== 1;
    inLayer.set(key, v);
  }
  return v;
}

// true: 層が止まっている / false: 動いている / null: 層が見えていない
export function layerAtRest(frame: LoggedFrame, orient: number, face: number, opts: TimingOptions = DEFAULT_TIMING): boolean | null {
  // 指先の縁や反射が1枚にかかり続けても判定できるよう、層のセルの 3/4 以上が止まっていれば止まっているとみなす
  let seen = 0;
  let still = 0;
  for (const f of frame.faces) {
    for (let cell = 0; cell < 9; cell++) {
      if (!cellInLayer(orient, f.slot, cell, face)) continue;
      if (f.masked?.[cell]) continue;
      seen++;
      if (f.valid[cell] && !(f.spread && f.spread[cell] > opts.restSpread)) still++;
    }
  }
  if (seen < 1) return null;
  return still >= Math.ceil(seen * 0.75);
}

function indexAtOrBefore(frames: LoggedFrame[], t: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export interface MoveTiming {
  start: number;
  end: number;
  exact: boolean; // 層が見えていてフレームから決められた
}

export function moveTiming(frames: LoggedFrame[], m: DecodedMove, opts: TimingOptions = DEFAULT_TIMING): MoveTiming {
  const t0 = m.t0 ?? m.t;
  const fallback = { start: t0, end: m.t, exact: false };
  if (!frames.length || m.inferred) return fallback;
  const face = moveFace(m.move);
  // 開始: t0 から遡って、層が止まっていた最後のフレーム
  let i = indexAtOrBefore(frames, t0);
  if (i < 0) return fallback;
  let restIdx = -1;
  for (let k = i; k >= 0 && frames[k].t >= t0 - opts.searchMs; k--) {
    const r = layerAtRest(frames[k], m.orient, face, opts);
    if (r === true) {
      restIdx = k;
      break;
    }
  }
  let start = t0;
  let exact = false;
  if (restIdx >= 0) {
    // 動き出し: 静止していたフレームを基準に、層のセル（その時点で止まっていたもの）のどれかが
    // 変わり始めた最初のフレーム。少しの回転でもサンプルの色が動くので、ばらつきより早く分かる
    const base = frames[restIdx];
    const ref = new Map<string, { lab: Lab; slot: number; cell: number }>();
    for (const f of base.faces)
      for (let cell = 0; cell < 9; cell++) {
        if (!cellInLayer(m.orient, f.slot, cell, face) || f.masked?.[cell] || !f.valid[cell]) continue;
        if (f.spread && f.spread[cell] > opts.restSpread) continue;
        ref.set(`${f.slot}:${cell}`, { lab: f.labs[cell], slot: f.slot, cell });
      }
    let onset = -1;
    for (let k = restIdx + 1; k < frames.length && frames[k].t <= m.t; k++) {
      let changed = 0;
      for (const f of frames[k].faces)
        for (let cell = 0; cell < 9; cell++) {
          const r = ref.get(`${f.slot}:${cell}`);
          if (!r || f.masked?.[cell]) continue;
          const d = Math.hypot(f.labs[cell][0] - r.lab[0], f.labs[cell][1] - r.lab[1], f.labs[cell][2] - r.lab[2]);
          if (!f.valid[cell] || (f.spread && f.spread[cell] > opts.restSpread) || d > opts.onsetDelta) changed++;
        }
      if (changed >= 1) {
        onset = k;
        break;
      }
    }
    if (onset > 0) {
      start = (frames[onset - 1].t + frames[onset].t) / 2;
      exact = true;
    } else if (restIdx + 1 < frames.length) {
      start = (frames[restIdx].t + frames[restIdx + 1].t) / 2;
      exact = true;
    }
  }
  // 終了: 動き出した後、再び止まった最初のフレーム（観測時刻の少し後まで探す）
  let end = m.t;
  i = restIdx >= 0 ? restIdx + 1 : Math.max(0, indexAtOrBefore(frames, t0));
  let moving = false;
  for (let k = i; k < frames.length && frames[k].t <= m.t + opts.searchMs; k++) {
    const r = layerAtRest(frames[k], m.orient, face, opts);
    if (r === false) moving = true;
    else if (r === true && moving && k > 0 && frames[k].t >= start) {
      end = (frames[k - 1].t + frames[k].t) / 2;
      break;
    }
  }
  return { start, end: Math.max(start, end), exact };
}

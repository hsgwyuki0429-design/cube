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
  // 動き出しを探すのは、前の見え方が最後に確認できた時刻（t0）からこれだけ前まで。層が回り始めても 20〜30° までは
  // 前の見え方のままなので、本当の開始は t0 の少し前にある（それより前の変化は指の動きなど）
  onsetWindowMs: number;
  refs?: Lab[]; // キューブの 6 色。分かっていれば、どの色からも遠いセル（指・手）を判定に使わない
}

export const DEFAULT_TIMING: TimingOptions = { restSpread: 22, onsetDelta: 9, searchMs: 450, onsetWindowMs: 150 };

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// キューブの色らしいか（指や手が乗ったセルは、どの色からも遠い）
function cubeLike(lab: Lab, refs?: Lab[]): boolean {
  if (!refs) return true;
  let best = Infinity;
  for (const r of refs) best = Math.min(best, Math.hypot((lab[0] - r[0]) / 2, lab[1] - r[1], lab[2] - r[2]));
  return best < 30;
}

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

const labDist = (a: Lab, b: Lab) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// セルが止まっているか: 隣のフレーム（near）と色もセル内のばらつきもほぼ同じ。隣と比べられなければ、ばらつきが小さいこと。
// 映り込みでばらつきが常に大きいセルも、隣と同じなら止まっている。回り始めの 1 フレームは色の動きが小さくても
// ばらつきが大きく変わる（サンプル点が隙間や隣のステッカーにかかる）ので、それも動きとみなす
function cellStill(f: LoggedFace, cell: number, near: LoggedFace | undefined, opts: TimingOptions): boolean {
  if (!f.valid[cell]) return false;
  const s = f.spread?.[cell] ?? 0;
  if (!near || !near.valid[cell] || near.masked?.[cell]) return s <= opts.restSpread;
  return labDist(f.labs[cell], near.labs[cell]) <= opts.onsetDelta && Math.abs(s - (near.spread?.[cell] ?? 0)) <= opts.restSpread / 2;
}

// true: 層が止まっている / false: 動いている / null: 層が見えていない。near は比べる隣のフレーム（前か後）
export function layerAtRest(frame: LoggedFrame, orient: number, face: number, opts: TimingOptions = DEFAULT_TIMING, near?: LoggedFrame): boolean | null {
  // 指先の縁や反射が1枚にかかり続けても判定できるよう、層のセルの 3/4 以上が止まっていれば止まっているとみなす
  let seen = 0;
  let still = 0;
  for (const f of frame.faces) {
    const n = near?.faces.find((x) => x.slot === f.slot);
    for (let cell = 0; cell < 9; cell++) {
      if (!cellInLayer(orient, f.slot, cell, face)) continue;
      if (f.masked?.[cell]) continue;
      // 指が乗っている（キューブの色でない）セルは、止まっているかどうかの判断に使わない
      if (f.valid[cell] && !cubeLike(f.labs[cell], opts.refs)) continue;
      seen++;
      if (cellStill(f, cell, n, opts)) still++;
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
  moved: boolean; // 層が動き出したフレームを見つけた（exact でも、静止の終わりしか分からないことがある）
}

export function moveTiming(frames: LoggedFrame[], m: DecodedMove, opts: TimingOptions = DEFAULT_TIMING): MoveTiming {
  const t0 = m.t0 ?? m.t;
  const fallback = { start: t0, end: m.t, exact: false, moved: false };
  if (!frames.length || m.inferred) return fallback;
  const face = moveFace(m.move);
  // 開始: t0 から遡って、層が止まっていた最後のフレーム
  let i = indexAtOrBefore(frames, t0);
  if (i < 0) return fallback;
  let restIdx = -1;
  for (let k = i; k >= 0 && frames[k].t >= t0 - opts.onsetWindowMs; k--) {
    const r = layerAtRest(frames[k], m.orient, face, opts, frames[k - 1]);
    if (r === true) {
      restIdx = k;
      break;
    }
  }
  let start = t0;
  let exact = false;
  let moved = false;
  if (restIdx >= 0) {
    // 動き出し: 静止していたフレームを基準に、層のセル（その時点で止まっていたもの）のどれかが
    // 変わり始めた最初のフレーム。少しの回転でもサンプルの色が動くので、ばらつきより早く分かる
    const base = frames[restIdx];
    const ref = new Map<string, { lab: Lab; spread: number }>();
    for (const f of base.faces) {
      const n = frames[restIdx - 1]?.faces.find((x) => x.slot === f.slot);
      for (let cell = 0; cell < 9; cell++) {
        if (!cellInLayer(m.orient, f.slot, cell, face) || f.masked?.[cell]) continue;
        if (!cellStill(f, cell, n, opts) || !cubeLike(f.labs[cell], opts.refs)) continue;
        ref.set(`${f.slot}:${cell}`, { lab: f.labs[cell], spread: f.spread?.[cell] ?? 0 });
      }
    }
    // 指がセルの上を横切っただけで「動き出した」としないよう、層のセルが 2 つ以上（基準が少なければ 1 つ）
    // 変わり、次に比べられるフレームでも変わったままのときだけ動き出しとする。
    // 変わった = 読めない・色が動いた・ばらつきが静止時から大きく変わった（映り込みのあるセルは静止時から大きい）
    const need = ref.size >= 3 ? 2 : 1;
    const changedAt = (k: number): number | null => {
      let changed = 0;
      let compared = 0;
      for (const f of frames[k].faces)
        for (let cell = 0; cell < 9; cell++) {
          const r = ref.get(`${f.slot}:${cell}`);
          if (!r || f.masked?.[cell]) continue;
          compared++;
          const s = f.spread?.[cell] ?? 0;
          const spreadMoved = s > Math.max(opts.restSpread, r.spread + opts.restSpread / 2) || s < r.spread - opts.restSpread / 2;
          if (!f.valid[cell] || spreadMoved || labDist(f.labs[cell], r.lab) > opts.onsetDelta) changed++;
        }
      return compared ? changed : null;
    };
    let onset = -1;
    for (let k = restIdx + 1; k < frames.length && frames[k].t <= m.t; k++) {
      if ((changedAt(k) ?? 0) < need) continue;
      // 次に層が見えるフレーム（指で隠れたフレームは飛ばす）
      let next: number | null = null;
      for (let j = k + 1; j < frames.length && frames[j].t <= m.t + opts.searchMs && next === null; j++) next = changedAt(j);
      if (next !== null && next < need) continue;
      onset = k;
      break;
    }
    if (onset > 0) {
      // 回り始めの 1〜2 フレームは、変わるセルが 1 つだけのことがある（少し回っただけ）。確かめた動き出しから、
      // 層が見えるフレームを 2 つまで遡り、1 つでも変わっていればそこを動き出しとする
      let prev = onset - 1;
      for (let steps = 0; steps < 2; ) {
        while (prev > restIdx && changedAt(prev) === null) prev--;
        if (prev <= restIdx || (changedAt(prev) ?? 0) < 1) break;
        onset = prev--;
        steps++;
      }
      // 動き出しは、最後に変わっていなかった（層が見えた）フレームと、動き出しのフレームの間
      start = (frames[Math.max(prev, restIdx)].t + frames[onset].t) / 2;
      exact = true;
      moved = true;
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
    const r = layerAtRest(frames[k], m.orient, face, opts, frames[k + 1]);
    if (r === false) moving = true;
    else if (r === true && moving && k > 0 && frames[k].t >= start) {
      end = (frames[k - 1].t + frames[k].t) / 2;
      break;
    }
  }
  return { start, end: Math.max(start, end), exact, moved };
}

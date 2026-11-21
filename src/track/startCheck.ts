// 始まりの状態の確かめ（精密解析）。解き直しが「完成から後ろ向きにたどると、渡された始まりの状態（スクランブルの案内）と違う状態に着く」
// と言うとき（スクランブルを間違えて回した: offline.ts の backward）、その状態を、回し始める前に確かに読めたステッカーと照らす。
// 画質が悪いと、後ろ向きが途中で別の道に入ったまま最初の観測まで着いてしまい、違う始まりの状態を「完成」として返していた
// （1.5Mbps の IMG_5047・5048。本体はスクランブルを書き換えて確定として記録していた）。確かな読みの決め方は正解づくり
// （tests/debug/buildTruth.debug.test.ts）と同じ。DOM もカメラも知らない
import { type CubeState, VIEW, applyMove } from "../cube/model";
import { stickerIds } from "../cube/stickers";

// 確かな読みのマス: ID が読めて重み SURE_WEIGHT 以上のマスが SURE_FACE 個以上ある面の、そのマス（1・2 マスだけの面は位置がずれやすい）
export const SURE_WEIGHT = 0.85;
export const SURE_FACE = 4;
// 確かな読みのフレーム: 前後 STABLE_SPAN 枚ずつ（計 5 枚）で同じマスに同じステッカーが続いたマスが STABLE_CELLS 個以上
export const STABLE_SPAN = 2;
export const STABLE_CELLS = 5;

export interface FaceIds {
  slot: number;
  ids?: ArrayLike<number> | null;
  w?: ArrayLike<number> | null;
}

export interface StableFrame {
  t: number;
  cells: [number, number][]; // [カメラフレームの facelet（slot × 9 + マス）, ステッカーの ID]
}

// 1 フレームの確かな読みのマス
export function sureCellsOf(faces: readonly FaceIds[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const fc of faces) {
    const ids = fc.ids;
    if (!ids) continue;
    let n = 0;
    for (let c = 0; c < 9; c++) if (ids[c] >= 0 && (fc.w?.[c] ?? 1) >= SURE_WEIGHT) n++;
    if (n < SURE_FACE) continue;
    for (let c = 0; c < 9; c++) if (ids[c] >= 0 && (fc.w?.[c] ?? 1) >= SURE_WEIGHT) m.set(fc.slot * 9 + c, ids[c]);
  }
  return m;
}

// 確かな読みのフレーム（フレームは時刻の順）
export function stableFrames(readings: readonly { t: number; faces: readonly FaceIds[] }[]): StableFrame[] {
  return stableOf(readings.map((r) => ({ t: r.t, cells: sureCellsOf(r.faces) })));
}

function stableOf(maps: readonly { t: number; cells: Map<number, number> }[]): StableFrame[] {
  const out: StableFrame[] = [];
  for (let i = STABLE_SPAN; i + STABLE_SPAN < maps.length; i++) {
    const cells: [number, number][] = [];
    for (const [p, x] of maps[i].cells) {
      let ok = true;
      for (let d = -STABLE_SPAN; d <= STABLE_SPAN && ok; d++) if (d && maps[i + d].cells.get(p) !== x) ok = false;
      if (ok) cells.push([p, x]);
    }
    if (cells.length >= STABLE_CELLS) out.push({ t: maps[i].t, cells });
  }
  return out;
}

// 手順（時刻つき）と確かな読みの食い違い: 時刻の前後 near 手の状態のどれとも（24 通りの姿勢のどれでも）合わないフレーム
export function contradictions(start: CubeState, moves: readonly { move: number; end: number }[], frames: readonly StableFrame[], near = 3): { t: number }[] {
  const ids = [stickerIds(start)];
  let s = start;
  for (const m of moves) ids.push(stickerIds((s = applyMove(s, m.move))));
  const bad: { t: number }[] = [];
  for (const fr of frames) {
    let k0 = 0;
    while (k0 < moves.length && moves[k0].end <= fr.t) k0++;
    let ok = false;
    for (let k = Math.max(0, k0 - near); k <= Math.min(ids.length - 1, k0 + near) && !ok; k++)
      for (let o = 0; o < 24 && !ok; o++) ok = fr.cells.every(([p, x]) => ids[k][VIEW[o * 54 + p]] === x);
    if (!ok) bad.push({ t: fr.t });
  }
  return bad;
}

// 後ろ向きだけでたどり着いた始まりの状態を認めてよいか。frames: 回し始める前（その答えの最初の手より前）の確かな読みのフレーム。
// 認めるのは、(1) その状態と食い違うフレームがほとんどなく（読み違いの続いたフレームを BACK_TOLERANCE の割合まで許す）、かつ
// (2) 渡された始まりの状態と食い違うフレームがはっきりある（スクランブルを間違えたと読みから言える: GIVEN_MIN 枚以上かつ割合
// GIVEN_SHARE 以上）とき。確かな読みが足りなければ認めない（「完成」にしない: 原則 3）
export const BACK_TOLERANCE = 0.05;
export const GIVEN_MIN = 3;
export const GIVEN_SHARE = 0.2;
export interface StartVerdict {
  ok: boolean;
  frames: number;
  back: number; // 後ろ向きの始まりの状態と食い違うフレーム
  given: number; // 渡された始まりの状態と食い違うフレーム
}
export function judgeBackwardStart(back: CubeState, given: CubeState, frames: readonly StableFrame[]): StartVerdict {
  const b = contradictions(back, [], frames, 0).length;
  const g = contradictions(given, [], frames, 0).length;
  const n = frames.length;
  const ok = n > 0 && b <= Math.floor(BACK_TOLERANCE * n) && g >= GIVEN_MIN && g >= GIVEN_SHARE * n && g > b;
  return { ok, frames: n, back: b, given: g };
}

// 精密解析のフレームごとの確かな読みのマスを、小さく持っておく（1 フレーム数十バイト。録画全体でも数百 KB）
export class SureLog {
  private times: number[] = [];
  private cells: Int16Array[] = []; // [p, x, p, x, …]
  push(t: number, faces: readonly FaceIds[]): void {
    const m = sureCellsOf(faces);
    const a = new Int16Array(m.size * 2);
    let i = 0;
    for (const [p, x] of m) {
      a[i++] = p;
      a[i++] = x;
    }
    this.times.push(t);
    this.cells.push(a);
  }
  // 時刻 [from, until) のフレームの、確かな読みのフレーム
  stable(from: number, until: number): StableFrame[] {
    const maps: { t: number; cells: Map<number, number> }[] = [];
    for (let k = 0; k < this.times.length; k++) {
      const t = this.times[k];
      if (t < from || t >= until) continue;
      const a = this.cells[k];
      const m = new Map<number, number>();
      for (let i = 0; i < a.length; i += 2) m.set(a[i], a[i + 1]);
      maps.push({ t, cells: m });
    }
    return stableOf(maps);
  }
}

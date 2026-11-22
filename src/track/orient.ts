// キューブ全体の向きを、手とは別に追う（ライブ。DOM もカメラも知らない）。
//
// 認識は面をカメラのスロット（正面・上・右…）に割り当てるが、キューブを傾けると割り当てが入れ替わる。角をカメラに向けて持つと
// 3 つの面がほぼ同じ角度になり、少し揺れるだけで「正面」が 3 つの面の間を行き来する。しかも割り当ては画像の向きに合わせて
// 決め直されるので（格子の 0 行目はいつも画像の上の辺）、前後のフレームのスロットの入れ替わりは 1 つの回転になっていないことがある。
// 追跡はそれを手で説明していた（傾けただけの偽の手）。
//
// そこで、スロットのラベルではなく面そのものを前後のフレームで突き合わせる: 同じ面（センターの ID・同じステッカーの ID がいちばん
// 多い面・外枠の真ん中がいちばん近い面）の外枠の 4 隅がどれに移ったか（画像の上の位置）から格子のマスどうしの対応を決め、同じ
// マスに残ったステッカーは「その間に回していない層にいる」（キューブ固定の位置が同じ）とみる。ステッカーごとに、いつから動いて
// いないか（since）を、突き合わせが続く限り引き継ぐ。
//
// 追跡（デコーダ）は観測ごとに「前の観測から動いていないステッカー」を受け取り（Observation.orient）、それを動かす層の手に
// コストを足し、動いていないステッカーが十分あれば持ち替えを無料にする（DecoderOptions.trackedOrient。ライブの設定だけ）。
// どの向きに持ち替えたかは、動いていないステッカーの状態の中の位置と見えているマスから、デコーダが今までどおり決める。
//
// 見分けられないもの: カメラを向いた面だけが見えていて、その面のステッカーが全部 90° 回った（その面を回した・キューブを視線の軸の
// まわりに回した）。外枠の 4 隅は同じ所に戻るので「動いた」とみて、今までどおり手の方が安い。中層回し・両側を同時に回す手では、
// 回していないはずの層のステッカーも同じマスに残らないので、動いていないステッカーが減るだけ（持ち替えは無料にならない）
import type { FrameReading } from "./observer";
import type { SightFrame } from "./sight";

export interface OrientOptions {
  maxGapMs: number; // これより前に見えた面とは突き合わせない
  matchDist: number; // 外枠の真ん中どうしの距離（面の大きさに対する割合）がこれ以内なら同じ面の候補（ID で決まらないとき）
  farDist: number; // ID で突き合わせた面でも、外枠の真ん中がこれより離れていたら同じ面とみない
  cornerRatio: number; // 外枠の 4 隅の対応: いちばん合う回し方の食い違いが、2 番目のこの割合より小さいときだけ決める
  cornerMax: number; // いちばん合う回し方の食い違い（面の大きさに対する割合）の上限（大きく形が変わったら決めない）
  maxShift: number; // マーカーの本体の格子からのずれ（マス）がこれより大きいマスは使わない（回している途中の層）
}

// ライブのデコーダの設定（controller.liveEngineOptions の decoder.trackedOrient）。実物の 7 本 × 6 通りの fps で選んだ（docs/history.md の
// 「向きを別に追う」）: 動いていないステッカーが 3 枚以上なら持ち替え 0.2・動いていないステッカーを動かす層の手 1 手ごとに +1.5
export const LIVE_TRACKED_ORIENT = { freeMin: 3, freeCost: 0.2, frozenCost: 1.5 };

export const DEFAULT_ORIENT: OrientOptions = { maxGapMs: 400, matchDist: 0.6, farDist: 1.5, cornerRatio: 0.6, cornerMax: 0.5, maxShift: 0.35 };

// 格子のマスの対応: 新しい格子の隅 (k + r) % 4 に、前の格子の隅 k が来た（隅は左上・右上・右下・左下）とき、前のマス c が新しいどのマスか
export const CELL_MAP = (() => {
  const t = new Uint8Array(36);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 9; c++) {
      let row = Math.floor(c / 3);
      let col = c % 3;
      for (let i = 0; i < r; i++) [row, col] = [col, 2 - row];
      t[r * 9 + c] = row * 3 + col;
    }
  return t;
})();

// ---- フレームの面 ----
interface Face {
  t: number;
  quad: [number, number][] | null; // 外枠の 4 隅（なければ null）
  center: [number, number] | null;
  size: number; // 外枠の辺の長さの平均（画素）
  ids: Int16Array; // 9 マス（-1 = 読めない・使わない）
  since: Float64Array; // 9 マス: そのステッカーがいつから同じ所にいるか
  centerId: number; // センターの ID（-1 = 読めない）
}

function facesOf(frame: FrameReading, sight: SightFrame | undefined, maxShift: number): Face[] {
  const out: Face[] = [];
  for (const f of frame.faces) {
    const s = sight?.faces.find((x) => x.slot === f.slot);
    const ids = new Int16Array(9).fill(-1);
    for (let c = 0; c < 9; c++) {
      const id = f.ids?.[c] ?? -1;
      if (id < 0 || !f.valid[c]) continue;
      const sh = f.shift?.[c];
      if (sh && Math.hypot(sh[0], sh[1]) > maxShift) continue;
      ids[c] = id;
    }
    let quad: [number, number][] | null = null;
    let center: [number, number] | null = null;
    let size = 0;
    if (s && s.quad.length === 8) {
      quad = [0, 1, 2, 3].map((k) => [s.quad[k * 2], s.quad[k * 2 + 1]]);
      center = [(quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4, (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4];
      for (let k = 0; k < 4; k++) size += Math.hypot(quad[(k + 1) % 4][0] - quad[k][0], quad[(k + 1) % 4][1] - quad[k][1]) / 4;
      if (!(size > 1)) quad = center = null;
    }
    const cid = ids[4] >= 0 && ids[4] % 9 === 4 ? ids[4] : -1;
    out.push({ t: frame.t, quad, center, size, ids, since: new Float64Array(9).fill(frame.t), centerId: cid });
  }
  return out;
}

// 前の面 a と今の面 b の外枠の 4 隅の対応（今の隅 (k + r) % 4 に前の隅 k）。真ん中の動きを差し引いて比べる。決まらなければ -1
function cornerTurn(a: Face, b: Face, o: OrientOptions): number {
  if (!a.quad || !b.quad || !a.center || !b.center) return -1;
  const d = [0, 0, 0, 0];
  for (let r = 0; r < 4; r++)
    for (let k = 0; k < 4; k++) {
      const p = a.quad[k];
      const q = b.quad[(k + r) % 4];
      d[r] += Math.hypot(q[0] - b.center[0] - (p[0] - a.center[0]), q[1] - b.center[1] - (p[1] - a.center[1]));
    }
  let best = 0;
  for (let r = 1; r < 4; r++) if (d[r] < d[best]) best = r;
  let second = Infinity;
  for (let r = 0; r < 4; r++) if (r !== best) second = Math.min(second, d[r]);
  const size = (a.size + b.size) / 2;
  if (d[best] / 4 > o.cornerMax * size || d[best] > o.cornerRatio * second) return -1;
  return best;
}

// 面を前後のフレームで突き合わせ、ステッカーごとに「いつから同じ所にいるか」を引き継ぐ
export class OrientTracker {
  readonly options: OrientOptions;
  private recent: Face[] = []; // 最近見えた面（新しい順。突き合わせた面は新しいものに置き換わる）
  private last: Face[] = []; // 最後のフレームの面
  matched = 0; // 突き合わせた面の数（調査用）
  faces = 0;

  constructor(options: Partial<OrientOptions> = {}) {
    this.options = { ...DEFAULT_ORIENT, ...options };
  }

  reset(): void {
    this.recent = [];
    this.last = [];
  }

  push(frame: FrameReading, sight: SightFrame | undefined): void {
    const o = this.options;
    if (!frame.faces.length) return;
    const faces = facesOf(frame, sight, o.maxShift);
    this.recent = this.recent.filter((a) => frame.t - a.t <= o.maxGapMs);
    const used = new Set<Face>();
    for (const b of faces) {
      this.faces++;
      const a = this.matchOf(b, used);
      if (!a) continue;
      if (a.center && b.center && Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]) > o.farDist * ((a.size + b.size) / 2)) continue;
      const r = cornerTurn(a, b, o);
      if (r < 0) continue;
      used.add(a);
      this.matched++;
      for (let c = 0; c < 9; c++) {
        const id = a.ids[c];
        if (id < 0) continue;
        const cb = CELL_MAP[r * 9 + c];
        if (b.ids[cb] === id) b.since[cb] = Math.min(b.since[cb], a.since[c]);
      }
    }
    // 突き合わせに使った前の面は今の面に置き換わる
    this.recent = [...faces, ...this.recent.filter((a) => !used.has(a))];
    this.last = faces;
  }

  // 前の同じ面: センターの ID → 同じステッカーの ID がいちばん多い（2 つ以上）→ 外枠の真ん中がいちばん近い（直前のフレームの面だけ）
  private matchOf(b: Face, used: Set<Face>): Face | null {
    const o = this.options;
    const free = this.recent.filter((a) => !used.has(a));
    if (b.centerId >= 0) {
      const a = free.find((x) => x.centerId === b.centerId);
      if (a) return a;
    }
    let best: Face | null = null;
    let most = 1;
    for (const a of free) {
      let n = 0;
      for (let c = 0; c < 9; c++) if (b.ids[c] >= 0 && a.ids.includes(b.ids[c])) n++;
      if (n > most) {
        most = n;
        best = a;
      }
    }
    if (best) return best;
    if (!b.center) return null;
    let near = o.matchDist;
    for (const a of free) {
      if (!a.center || !this.last.includes(a)) continue;
      const d = Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]) / ((a.size + b.size) / 2);
      if (d < near) {
        near = d;
        best = a;
      }
    }
    return best;
  }

  // 最後のフレームで見えたステッカーのうち、時刻 t0 から同じ所にいるもの（センターは除く: どの手でも動かない）
  stillSince(t0: number): number[] {
    const out: number[] = [];
    for (const f of this.last) for (let c = 0; c < 9; c++) if (c !== 4 && f.ids[c] >= 0 && f.since[c] <= t0) out.push(f.ids[c]);
    return out;
  }
}

// フレームごとの読み取りを「安定した観測」に変換する。回転中は面がぶれて読みが揺れるので何も出さず、
// 一定時間（stableMs、フレーム数にすると 30fps で1枚・60fps で2枚）同じ読みが続いたら、
// 前回の観測と違うときだけ観測としてデコーダへ渡す。高速回転では層がそろう瞬間が短いので、時間は短めにする。
import type { Lab } from "../vision/color";
import type { ColorModel } from "./colorModel";
import type { FaceObservation, Observation, TurnSnapshot } from "./types";

export interface FaceReading {
  slot: number;
  labs: Lab[]; // 9
  valid: boolean[]; // 9（手で隠れている・サンプリング不良なら false）
  weight?: number[]; // 9（セルの信頼度。省略時 1）
  spread?: number[]; // 9（セル内の色のばらつき。開始・終了時刻の判定に使う）
  masked?: boolean[]; // 9（手で隠れている）
  alts?: { labs: Lab[]; valid: boolean[] }[]; // 窓の位置が曖昧なとき、ずらした格子での読み
  ids?: number[]; // 9（マスごとに違う ArUco ステッカーの ID = 揃った状態での facelet 番号。-1 = 読めない）
  shift?: ([number, number] | null)[]; // 9（読んだマーカーの本体の格子からのずれ。開始・終了時刻の判定に使う）
}

export interface FrameReading {
  t: number;
  faces: FaceReading[];
  turn?: TurnSnapshot; // 回転途中の形で見えた層の回転（src/aruco/turn.ts）
}

export interface ObserverOptions {
  stableMs: number; // この時間だけ同じ読みが続いたら安定（フレーム間隔から枚数に換算、最低1枚）
  stableFrames?: number; // 指定すると枚数で固定
  minKnown: number; // 正面で最低これだけ色が読めていること
  minSideKnown?: number; // 上・横の面を観測に入れる、読めた色の数（既定 3）
  // 安定を見るフレームの間で、見えている面の組み合わせが揺れてもよい（どのフレームにもある面だけを使う）。
  // ArUco は斜めの面のマーカーが読めたり読めなかったりするので、組み合わせの一致を求めると観測が出ない
  mergeSlots?: boolean;
  singleFrameWeight: number; // 1フレームだけの観測の重み（1枚の誤読が1手分のコストを超えないように）
  idMismatchCost?: number; // 色は合うのに読んだステッカーと違うときのコスト（既定 1.0。1 手のコストと同じ）
}

// ArUco ステッカー: 読めたマスの色は ID から確定するので、少ないマスでも観測に入れる（ライブと精密解析で同じ）
export const ARUCO_OBSERVER: Partial<ObserverOptions> = { minKnown: 2, minSideKnown: 1, mergeSlots: true };

export const DEFAULT_OBSERVER: ObserverOptions = {
  stableMs: 33,
  minKnown: 5,
  singleFrameWeight: 0.6,
};

interface Labeled {
  t: number;
  faces: { slot: number; labs: Lab[]; labels: Int8Array; weight: number[]; ids: Int16Array | null }[];
}

const signature = (f: Labeled) => f.faces.map((x) => x.slot).sort().join(",");

function conflicts(a: Int8Array, b: Int8Array): number {
  let n = 0;
  for (let i = 0; i < 9; i++) if (a[i] >= 0 && b[i] >= 0 && a[i] !== b[i]) n++;
  return n;
}

// 両方で読めたステッカーが食い違うセルの数（同じ色の別のステッカー: 色だけでは見えない手が起きた）
function idConflicts(a: Int16Array | null | undefined, b: Int16Array | null | undefined): number {
  if (!a || !b) return 0;
  let n = 0;
  for (let i = 0; i < 9; i++) if (a[i] >= 0 && b[i] >= 0 && a[i] !== b[i]) n++;
  return n;
}

export class FaceObserver {
  options: ObserverOptions;
  private frames: Labeled[] = [];
  private last: { slots: string; faces: Map<number, Int8Array>; ids: Map<number, Int16Array | null> } | null = null;
  private lastConsistentT = 0;
  private deltas: number[] = [];
  private lastT: number | null = null;
  emitted = 0;
  lastWasRepeat = false; // 最後に出した観測が、前回と同じ読みの出し直しだった

  constructor(
    private colors: ColorModel,
    options: Partial<ObserverOptions> = {},
  ) {
    this.options = { ...DEFAULT_OBSERVER, ...options };
  }

  setColors(colors: ColorModel): void {
    this.colors = colors;
  }

  reset(): void {
    this.frames = [];
    this.last = null;
  }

  // 必要な枚数（フレーム間隔の中央値から）
  requiredFrames(): number {
    if (this.options.stableFrames) return this.options.stableFrames;
    const d = [...this.deltas].sort((a, b) => a - b);
    const interval = d.length ? d[d.length >> 1] : 33;
    return Math.max(1, Math.min(8, Math.round(this.options.stableMs / Math.max(1, interval))));
  }

  // repeat: 前回と同じ読みでも、安定していれば観測を出し直す（TrackerEngine の repeatMs）
  push(frame: FrameReading, repeat = false): Observation | null {
    const labeled: Labeled = {
      t: frame.t,
      faces: frame.faces.map((f) => ({
        slot: f.slot,
        labs: f.labs,
        labels: Int8Array.from(f.labs.map((lab, i) => (f.valid[i] ? this.colors.classify(lab).label : -1))),
        weight: f.weight ?? [1, 1, 1, 1, 1, 1, 1, 1, 1],
        ids: f.ids ? Int16Array.from(f.ids.map((id, i) => (f.valid[i] ? id : -1))) : null,
      })),
    };
    // 前回の観測とまだ矛盾していないなら、その観測は「この時刻まで続いていた」
    if (this.last && signature(labeled) === this.last.slots && labeled.faces.every((f) => conflicts(f.labels, this.last!.faces.get(f.slot)!) === 0 && idConflicts(f.ids, this.last!.ids.get(f.slot)) === 0)) {
      this.lastConsistentT = frame.t;
    }
    if (this.lastT !== null && frame.t > this.lastT) {
      this.deltas.push(frame.t - this.lastT);
      if (this.deltas.length > 15) this.deltas.shift();
    }
    this.lastT = frame.t;
    const { minKnown } = this.options;
    const stableFrames = this.requiredFrames();
    this.frames.push(labeled);
    while (this.frames.length > stableFrames) this.frames.shift();
    if (this.frames.length < stableFrames || !labeled.faces.length) return null;

    const sig = signature(labeled);
    // mergeSlots: どのフレームにもある面だけ（なければ従来どおり組み合わせの一致を求める）
    const common = this.options.mergeSlots ? labeled.faces.filter((f) => this.frames.every((g) => g.faces.some((x) => x.slot === f.slot))) : labeled.faces;
    if (!this.options.mergeSlots && this.frames.some((f) => signature(f) !== sig)) return null;
    if (!common.length) return null;
    for (const f of common) {
      const known = f.labels.reduce((n, l) => n + (l >= 0 ? 1 : 0), 0);
      if (known < minKnown && f.slot === 2) return null;
      for (const g of this.frames) {
        const gf = g.faces.find((x) => x.slot === f.slot)!;
        if (conflicts(gf.labels, f.labels) || idConflicts(gf.ids, f.ids)) return null;
      }
    }

    // 安定した: セルごとに読めたフレームの Lab を平均してコストを作る
    const faces: FaceObservation[] = [];
    for (const f of common) {
      const cost = new Float32Array(54);
      const labels = new Int8Array(9).fill(-1);
      // 読んだステッカー: 読めたフレームの ID（安定を見るフレームの間で食い違わないことは上で確かめた）
      const ids = f.ids ? new Int16Array(9).fill(-1) : null;
      const idCost = ids ? new Float32Array(9) : null;
      let known = 0;
      for (let cell = 0; cell < 9; cell++) {
        const labs: Lab[] = [];
        let wsum = 0;
        for (const g of this.frames) {
          const gf = g.faces.find((x) => x.slot === f.slot)!;
          if (gf.labels[cell] >= 0) {
            labs.push(gf.labs[cell]);
            wsum += gf.weight[cell];
          }
        }
        if (labs.length < Math.ceil(stableFrames / 2)) continue;
        const mean: Lab = [0, 1, 2].map((k) => labs.reduce((s, l) => s + l[k], 0) / labs.length) as Lab;
        labels[cell] = this.colors.costs(mean, cost, cell * 6);
        const wmean = (wsum / labs.length) * (this.frames.length === 1 ? this.options.singleFrameWeight : 1);
        if (wmean < 1) for (let c = 0; c < 6; c++) cost[cell * 6 + c] *= wmean;
        if (labels[cell] >= 0) known++;
        if (ids && idCost && labels[cell] >= 0) {
          for (const g of this.frames) {
            const id = g.faces.find((x) => x.slot === f.slot)!.ids?.[cell] ?? -1;
            if (id >= 0 && Math.floor(id / 9) === labels[cell]) ids[cell] = id;
          }
          if (ids[cell] >= 0) idCost[cell] = (this.options.idMismatchCost ?? 1) * Math.min(1, wmean);
        }
      }
      if (known >= (this.options.minSideKnown ?? 3) || f.slot === 2) {
        // 窓の位置をずらした読み（このフレームのもの）。どちらが正しいかはデコーダが決める
        const raw = frame.faces.find((x) => x.slot === f.slot);
        const alts = raw?.alts?.map((a) => {
          const c = new Float32Array(54);
          for (let cell = 0; cell < 9; cell++) {
            if (!a.valid[cell]) continue;
            this.colors.costs(a.labs[cell], c, cell * 6);
            const w = f.weight[cell] * (this.frames.length === 1 ? this.options.singleFrameWeight : 1);
            if (w < 1) for (let k = 0; k < 6; k++) c[cell * 6 + k] *= w;
          }
          return c;
        });
        const obsFace: FaceObservation = alts?.length ? { slot: f.slot, cost, labels, alts } : { slot: f.slot, cost, labels };
        if (ids && idCost && ids.some((id) => id >= 0)) Object.assign(obsFace, { ids, idCost });
        faces.push(obsFace);
      }
    }
    if (!faces.some((f) => f.slot === 2)) return null;

    const slots = faces.map((f) => f.slot).sort().join(",");
    let sameAsLast = false;
    if (this.last) {
      const same =
        this.last.slots === slots &&
        faces.every((f) => {
          const prev = this.last!.faces.get(f.slot)!;
          if (conflicts(prev, f.labels) || idConflicts(this.last!.ids.get(f.slot), f.ids)) return false;
          // 新しく読めるようになったセルが2枚以上あれば情報が増えたので出す。色だけだったセルの ID が読めるようになったのも
          // 同じ（色で補ったマスは重みが低い。そのままでは、色だけの弱い観測で手を足さなかった後、ID の読めた観測が出なかった）
          const prevIds = this.last!.ids.get(f.slot);
          let gained = 0;
          for (let i = 0; i < 9; i++) if ((prev[i] < 0 && f.labels[i] >= 0) || (f.ids && f.ids[i] >= 0 && (!prevIds || prevIds[i] < 0))) gained++;
          return gained < 2;
        });
      sameAsLast = same;
      if (same && !repeat) {
        this.lastConsistentT = frame.t;
        return null;
      }
    }
    this.lastWasRepeat = !!this.last && repeat && sameAsLast;
    const t = this.frames[0].t;
    const tPrevEnd = this.last ? Math.min(this.lastConsistentT, t) : t;
    this.last = { slots, faces: new Map(faces.map((f) => [f.slot, f.labels])), ids: new Map(faces.map((f) => [f.slot, f.ids ?? null])) };
    this.lastConsistentT = frame.t;
    this.emitted++;
    return { t, tPrevEnd, faces };
  }
}

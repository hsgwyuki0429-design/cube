// フレームごとの読み取りを「安定した観測」に変換する。回転中は面がぶれて読みが揺れるので何も出さず、
// 一定時間（stableMs、フレーム数にすると 30fps で1枚・60fps で2枚）同じ読みが続いたら、
// 前回の観測と違うときだけ観測としてデコーダへ渡す。高速回転では層がそろう瞬間が短いので、時間は短めにする。
import type { Lab } from "../vision/color";
import type { ColorModel } from "./colorModel";
import type { FaceObservation, Observation } from "./types";

export interface FaceReading {
  slot: number;
  labs: Lab[]; // 9
  valid: boolean[]; // 9（手で隠れている・サンプリング不良なら false）
  weight?: number[]; // 9（セルの信頼度。省略時 1）
  spread?: number[]; // 9（セル内の色のばらつき。開始・終了時刻の判定に使う）
  masked?: boolean[]; // 9（手で隠れている）
}

export interface FrameReading {
  t: number;
  faces: FaceReading[];
}

export interface ObserverOptions {
  stableMs: number; // この時間だけ同じ読みが続いたら安定（フレーム間隔から枚数に換算、最低1枚）
  stableFrames?: number; // 指定すると枚数で固定
  minKnown: number; // 1面あたり最低これだけ色が読めていること
  singleFrameWeight: number; // 1フレームだけの観測の重み（1枚の誤読が1手分のコストを超えないように）
}

export const DEFAULT_OBSERVER: ObserverOptions = {
  stableMs: 33,
  minKnown: 5,
  singleFrameWeight: 0.6,
};

interface Labeled {
  t: number;
  faces: { slot: number; labs: Lab[]; labels: Int8Array; weight: number[] }[];
}

const signature = (f: Labeled) => f.faces.map((x) => x.slot).sort().join(",");

function conflicts(a: Int8Array, b: Int8Array): number {
  let n = 0;
  for (let i = 0; i < 9; i++) if (a[i] >= 0 && b[i] >= 0 && a[i] !== b[i]) n++;
  return n;
}

export class FaceObserver {
  options: ObserverOptions;
  private frames: Labeled[] = [];
  private last: { slots: string; faces: Map<number, Int8Array> } | null = null;
  private lastConsistentT = 0;
  private deltas: number[] = [];
  private lastT: number | null = null;
  emitted = 0;

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

  push(frame: FrameReading): Observation | null {
    const labeled: Labeled = {
      t: frame.t,
      faces: frame.faces.map((f) => ({
        slot: f.slot,
        labs: f.labs,
        labels: Int8Array.from(f.labs.map((lab, i) => (f.valid[i] ? this.colors.classify(lab).label : -1))),
        weight: f.weight ?? [1, 1, 1, 1, 1, 1, 1, 1, 1],
      })),
    };
    // 前回の観測とまだ矛盾していないなら、その観測は「この時刻まで続いていた」
    if (this.last && signature(labeled) === this.last.slots && labeled.faces.every((f) => conflicts(f.labels, this.last!.faces.get(f.slot)!) === 0)) {
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
    if (this.frames.some((f) => signature(f) !== sig)) return null;
    for (const f of labeled.faces) {
      const known = f.labels.reduce((n, l) => n + (l >= 0 ? 1 : 0), 0);
      if (known < minKnown && f.slot === 2) return null;
      for (const g of this.frames) {
        const gf = g.faces.find((x) => x.slot === f.slot)!;
        if (conflicts(gf.labels, f.labels)) return null;
      }
    }

    // 安定した: セルごとに読めたフレームの Lab を平均してコストを作る
    const faces: FaceObservation[] = [];
    for (const f of labeled.faces) {
      const cost = new Float32Array(54);
      const labels = new Int8Array(9).fill(-1);
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
      }
      if (known >= 3 || f.slot === 2) faces.push({ slot: f.slot, cost, labels });
    }
    if (!faces.some((f) => f.slot === 2)) return null;

    const slots = faces.map((f) => f.slot).sort().join(",");
    if (this.last) {
      const same =
        this.last.slots === slots &&
        faces.every((f) => {
          const prev = this.last!.faces.get(f.slot)!;
          if (conflicts(prev, f.labels)) return false;
          // 新しく読めるようになったセルが2枚以上あれば情報が増えたので出す
          let gained = 0;
          for (let i = 0; i < 9; i++) if (prev[i] < 0 && f.labels[i] >= 0) gained++;
          return gained < 2;
        });
      if (same) {
        this.lastConsistentT = frame.t;
        return null;
      }
    }
    const t = this.frames[0].t;
    const tPrevEnd = this.last ? Math.min(this.lastConsistentT, t) : t;
    this.last = { slots, faces: new Map(faces.map((f) => [f.slot, f.labels])) };
    this.lastConsistentT = frame.t;
    this.emitted++;
    return { t, tPrevEnd, faces };
  }
}

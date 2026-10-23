// フレームごとの読み取りを「安定した観測」に変換する。回転中は面がぶれて読みが揺れるので何も出さず、
// 数フレーム同じ読みが続いたら、前回の観測と違うときだけ観測としてデコーダへ渡す。
import type { Lab } from "../vision/color";
import type { ColorModel } from "./colorModel";
import type { FaceObservation, Observation } from "./types";

export interface FaceReading {
  slot: number;
  labs: Lab[]; // 9
  valid: boolean[]; // 9（手で隠れている・サンプリング不良なら false）
}

export interface FrameReading {
  t: number;
  faces: FaceReading[];
}

export interface ObserverOptions {
  stableFrames: number; // この枚数だけ同じ読みが続いたら安定
  minKnown: number; // 1面あたり最低これだけ色が読めていること
}

export const DEFAULT_OBSERVER: ObserverOptions = {
  stableFrames: 3,
  minKnown: 5,
};

interface Labeled {
  t: number;
  faces: { slot: number; labs: Lab[]; labels: Int8Array }[];
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

  push(frame: FrameReading): Observation | null {
    const labeled: Labeled = {
      t: frame.t,
      faces: frame.faces.map((f) => ({
        slot: f.slot,
        labs: f.labs,
        labels: Int8Array.from(f.labs.map((lab, i) => (f.valid[i] ? this.colors.classify(lab).label : -1))),
      })),
    };
    // 前回の観測とまだ矛盾していないなら、その観測は「この時刻まで続いていた」
    if (this.last && signature(labeled) === this.last.slots && labeled.faces.every((f) => conflicts(f.labels, this.last!.faces.get(f.slot)!) === 0)) {
      this.lastConsistentT = frame.t;
    }
    const { stableFrames, minKnown } = this.options;
    this.frames.push(labeled);
    if (this.frames.length > stableFrames) this.frames.shift();
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
        for (const g of this.frames) {
          const gf = g.faces.find((x) => x.slot === f.slot)!;
          if (gf.labels[cell] >= 0) labs.push(gf.labs[cell]);
        }
        if (labs.length < Math.ceil(stableFrames / 2)) continue;
        const mean: Lab = [0, 1, 2].map((k) => labs.reduce((s, l) => s + l[k], 0) / labs.length) as Lab;
        labels[cell] = this.colors.costs(mean, cost, cell * 6);
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

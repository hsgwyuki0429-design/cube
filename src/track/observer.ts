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
  idBoost?: number; // ステッカーの ID が読めたマスの矛盾のコストの倍率（既定 1）
  // 1 枚だけ見えた状態も観測にする（2 枚以上で安定を見るとき。精密解析）。速い手順では層が止まって読めるのは 1 枚だけのことが多く、
  // 2 枚続くのを待つと手と手の間の状態が観測にならず、観測の間に何手も詰まって見失っていた。前の観測と食い違う 1 枚を取っておき、
  // 次に読めたフレームが前の観測に戻っていれば 1 枚の誤読として捨て、取っておいた 1 枚とも前の観測とも食い違えば（その状態を
  // 通り過ぎた）その 1 枚を観測にする。取っておいた 1 枚と合えば、いつもどおり 2 枚続いた観測になる
  transient?: boolean;
  transientWaitMs?: number; // 取っておいた 1 枚を決めるのを待つ長さ（既定 200ms。読めないフレームが続いたら捨てる）
  transientIdBoost?: number; // その 1 枚の ID の矛盾のコストの倍率（既定 idBoost。1 枚だけの観測は singleFrameWeight で軽くなる）
  transientMinIds?: number; // その 1 枚で ID が読めたマスがこれより少なければ観測にしない（既定 0）
}

// 2 つの読みが同じマスで読めた数と、食い違った数（色・ID）
function compare(faces: Labeled["faces"], labels: (slot: number) => Int8Array | undefined, ids: (slot: number) => Int16Array | null | undefined) {
  let overlap = 0;
  let diff = 0;
  for (const f of faces) {
    const l = labels(f.slot);
    if (!l) continue;
    const d = ids(f.slot);
    for (let i = 0; i < 9; i++) {
      if (f.labels[i] < 0 || l[i] < 0) continue;
      overlap++;
      if (f.labels[i] !== l[i] || (f.ids && d && f.ids[i] >= 0 && d[i] >= 0 && f.ids[i] !== d[i])) diff++;
    }
  }
  return { overlap, diff };
}

// ArUco ステッカー: 読めたマスの色は ID から確定するので、少ないマスでも観測に入れる（ライブと精密解析で同じ）
// transient: 精密解析（60fps で 2 枚続くのを待つ）でも、1 枚だけ見えた手と手の間の状態を観測にする（ライブは 1 枚で観測にするので
//   使われない）。実物のソルブ 4 本・5Mbps で、フレームの読みでは分かる手と手の間の状態 289 個のうち観測になったのは 234 個だけで、
//   落ちた所が「観測の間に 5〜8 手詰まって見失う」所だった（IMG_4972 の 22.3 秒: フレームでは 6 つ中 3〜5 つ分かるのに観測は 0）。
//   ID が 5 個未満の 1 枚は足さない（IMG_5048 の 2.5Mbps で、正解が候補から消えた直後に ID 3 個の 1 枚が候補を引っ張り、戻れなかった）。
//   全部を 1 枚で観測にする（stableFrames: 1）と観測が 1.8 倍・解き直しが 2 倍になり、1 枚の誤読で崩れる本も出た
export const ARUCO_OBSERVER: Partial<ObserverOptions> = { minKnown: 2, minSideKnown: 1, mergeSlots: true, transient: true, transientMinIds: 5 };

// ライブの観測（controller.liveEngineOptions）: 読めたステッカーの ID を強く信じ、1 フレームでも観測にする。
//   idBoost: ID の読みはほとんど間違えない（実物・合成とも違う ID に読んだマスは 0）のに、色を読んでいた頃のまま「1 マスの矛盾 1.5・
//     1 フレームだけなら 0.6 倍」だと、矛盾 1 マス（0.9）が 1 手（1.0）より安く、手を足す代わりに誤読として片付けていた。実物のソルブで
//     面の割り当てが 1 フレームだけ入れ替わった（上の面を正面と読んだ）とき、真ん中のステッカーの食い違いを誤読として残りを違う手で
//     説明し、そのまま外れていった。2 倍にすると、実物の動画 3 本 × 1 秒 6〜20 枚で 3D が本当の状態と同じだった時間が 65 → 76%
//   stableFrames: 60fps をすべて処理できるときも 2 枚続くのを待たない（速い手順では層が止まって読めるのは 1 枚。実物の速い T-perm を
//     全フレームで 30 → 90%）
export const LIVE_OBSERVER: Partial<ObserverOptions> = { idBoost: 2, stableFrames: 1 };

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
  private held: { labeled: Labeled; frame: FrameReading } | null = null;
  emitted = 0;
  transients = 0; // 1 枚だけ見えた状態から出した観測の数（調査用）
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
    this.held = null;
  }

  // 前の観測と食い違う 1 枚を取っておく（2 枚続かなかったとき）
  private hold(labeled: Labeled, frame: FrameReading, stableFrames: number): null {
    if (!this.options.transient || stableFrames < 2 || !labeled.faces.length || !this.last || this.held) return null;
    const last = this.last;
    const c = compare(labeled.faces, (s) => last.faces.get(s), (s) => last.ids.get(s));
    const ids = labeled.faces.reduce((n, f) => n + (f.ids ? f.ids.filter((x) => x >= 0).length : 0), 0);
    if (c.diff > 0 && ids >= (this.options.transientMinIds ?? 0)) this.held = { labeled, frame };
    return null;
  }

  // 取っておいた 1 枚を、次に読めたフレームで決める（観測にするならそれを返す）
  private decideHeld(labeled: Labeled): Observation | null {
    const h = this.held;
    if (!h || !this.last) return null;
    if (h.labeled === labeled) return null;
    if (labeled.t - h.labeled.t > (this.options.transientWaitMs ?? 200)) {
      this.held = null;
      return null;
    }
    const last = this.last;
    const toHeld = compare(labeled.faces, (s) => h.labeled.faces.find((f) => f.slot === s)?.labels, (s) => h.labeled.faces.find((f) => f.slot === s)?.ids);
    const toLast = compare(labeled.faces, (s) => last.faces.get(s), (s) => last.ids.get(s));
    if (toHeld.overlap && !toHeld.diff) {
      // 同じ状態が続いた: いつもどおり 2 枚続いた観測になる
      this.held = null;
      return null;
    }
    if (toLast.overlap && !toLast.diff) {
      // 前の観測に戻った: 1 枚の誤読
      this.held = null;
      return null;
    }
    if (!toHeld.diff || !toLast.diff) return null; // どちらとも比べられない: もう少し待つ
    this.held = null;
    const faces = this.compose([h.labeled], 1, h.frame, this.options.transientIdBoost);
    if (!faces) return null;
    const obs = this.emit(faces, h.labeled.t, false, h.labeled.t);
    if (obs) this.transients++;
    return obs;
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
    const stableFrames = this.requiredFrames();
    this.frames.push(labeled);
    while (this.frames.length > stableFrames) this.frames.shift();
    // 1 枚だけ見えた状態（transient）: 取っておいた 1 枚を、このフレームで決める
    const held = labeled.faces.length ? this.decideHeld(labeled) : null;
    if (held) {
      // 取っておいた 1 枚を出した: このフレームも、それと食い違えば取っておく
      this.hold(labeled, frame, stableFrames);
      return held;
    }
    if (this.frames.length < stableFrames || !labeled.faces.length) return this.hold(labeled, frame, stableFrames);
    const faces = this.compose(this.frames, stableFrames, frame);
    if (!faces) return this.hold(labeled, frame, stableFrames);
    this.held = null;
    return this.emit(faces, frame.t, repeat);
  }

  // 安定を見るフレームの読みをまとめて、観測の面を作る（安定していなければ null）
  private compose(frames: Labeled[], stableFrames: number, frame: FrameReading, idBoost = this.options.idBoost): FaceObservation[] | null {
    const { minKnown } = this.options;
    const labeled = frames[frames.length - 1];
    const sig = signature(labeled);
    // mergeSlots: どのフレームにもある面だけ（なければ従来どおり組み合わせの一致を求める）
    const common = this.options.mergeSlots ? labeled.faces.filter((f) => frames.every((g) => g.faces.some((x) => x.slot === f.slot))) : labeled.faces;
    if (!this.options.mergeSlots && frames.some((f) => signature(f) !== sig)) return null;
    if (!common.length) return null;
    for (const f of common) {
      const known = f.labels.reduce((n, l) => n + (l >= 0 ? 1 : 0), 0);
      if (known < minKnown && f.slot === 2) return null;
      for (const g of frames) {
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
        for (const g of frames) {
          const gf = g.faces.find((x) => x.slot === f.slot)!;
          if (gf.labels[cell] >= 0) {
            labs.push(gf.labs[cell]);
            wsum += gf.weight[cell];
          }
        }
        if (labs.length < Math.ceil(stableFrames / 2)) continue;
        const mean: Lab = [0, 1, 2].map((k) => labs.reduce((s, l) => s + l[k], 0) / labs.length) as Lab;
        labels[cell] = this.colors.costs(mean, cost, cell * 6);
        const wmean = (wsum / labs.length) * (frames.length === 1 ? this.options.singleFrameWeight : 1);
        if (wmean < 1) for (let c = 0; c < 6; c++) cost[cell * 6 + c] *= wmean;
        if (labels[cell] >= 0) known++;
        if (ids && idCost && labels[cell] >= 0) {
          for (const g of frames) {
            const id = g.faces.find((x) => x.slot === f.slot)!.ids?.[cell] ?? -1;
            if (id >= 0 && Math.floor(id / 9) === labels[cell]) ids[cell] = id;
          }
          if (ids[cell] >= 0) idCost[cell] = (this.options.idMismatchCost ?? 1) * Math.min(1, wmean);
          const boost = idBoost ?? 1;
          if (ids[cell] >= 0 && boost !== 1) {
            for (let c = 0; c < 6; c++) cost[cell * 6 + c] *= boost;
            idCost[cell] *= boost;
          }
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
            const w = f.weight[cell] * (frames.length === 1 ? this.options.singleFrameWeight : 1);
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
    return faces;
  }

  private emit(faces: FaceObservation[], frameT: number, repeat: boolean, t0 = this.frames[0].t): Observation | null {
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
        this.lastConsistentT = frameT;
        return null;
      }
    }
    this.lastWasRepeat = !!this.last && repeat && sameAsLast;
    const t = t0;
    const tPrevEnd = this.last ? Math.min(this.lastConsistentT, t) : t;
    this.last = { slots, faces: new Map(faces.map((f) => [f.slot, f.labels])), ids: new Map(faces.map((f) => [f.slot, f.ids ?? null])) };
    this.lastConsistentT = frameT;
    this.emitted++;
    return { t, tPrevEnd, faces };
  }
}

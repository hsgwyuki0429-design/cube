// ソルブ後の精密解析: 録画した全フレームを1枚ずつ、リアルタイムより重い設定で認識・追跡し直す。
// 手順と、各手の開始・終了時刻（フレームの記録から求めた、誤差はフレーム間隔の半分程度）を出す。
// OpenCV のオブジェクトは呼び出し側が渡すので、Worker でもテスト（Node）でも同じコードが動く。
import { type CubeState, OPPOSITE, isSolved, moveFace, solvedState, statesEqual } from "../cube/model";
import { type EngineOptions, TrackerEngine } from "../track/engine";
import { mergeQuickRepeats, simplifyMoves } from "../track/merge";
import { DEFAULT_OFFLINE, decodeOffline } from "../track/offline";
import type { DecodedMove, TrackStatus } from "../track/types";
import type { Lab } from "./color";
import { type PatchFrame, facePatch, refineEnd, refineStart } from "./fineTiming";
import type { CV, PixelSource } from "./image";
import { DEFAULT_PIPELINE, type PipelineConfig, processFrame } from "./pipeline";
import { type FaceLayer, cellH } from "../aruco/cube";
import { type Mat3, applyH } from "./homography";

export interface RefineInput {
  state: number[]; // 解析範囲の始まりの状態（スクランブル後）
  refs: Lab[];
  orients?: number[];
  from: number; // 解析する範囲（ms）
  to: number;
  startHint?: number; // 最初の手のおおよその時刻（リアルタイムの追跡から）。タイムの両端の画素を残す範囲を絞る
  engine?: Partial<EngineOptions>;
  pipeline?: Partial<PipelineConfig>;
  // タイムを測らない解析（フリー）: 画素のパッチは直近のこれだけ残す（長く続けてもメモリが増えないように）
  keepPatchesMs?: number;
  // 軽い検査で、前に精密に処理したフレームとマスの色が同じフレームを飛ばす（既定 true。下の「軽い検査」）
  gate?: boolean;
}

// 軽い検査: 全フレームを精密に処理する代わりに、前に精密に処理したフレーム（基準）の面の格子で、各マスの真ん中あたりの色を数点だけ測り
// （CHECK_POINTS × CHECK_POINTS 点の平均。1 フレーム 0.1ms 程度）、基準と同じなら飛ばす。層を回す・持ち替える・指が動く・キューブが
// 揺れて格子からずれると色が変わるので精密に処理する（迷ったら精密に。読み違えて飛ばすことはない向き）。
// 変わっていたら、取っておいた直前のフレーム（変わる前の最後の 1 枚。回し始めの時刻に要る）と、そのフレームを精密に処理し、
// その後 GATE_TAIL 枚も精密に処理する（回し終わりの時刻は、止まった後のフレームでも止まっていることを確かめる）。GATE_KEEP_MS ごとにも精密に
// （ライブ並みの認識を軽い検査にすると、精密な処理の 7 割ほどかかり、飛ばしても全体では遅くなった）
const GATE_KEEP_MS = 200;
const GATE_TAIL = 2;
const CHECK_POINTS = 3;
const CHECK_DIFF = 18; // マスの色（R・G・B の平均の差の最大）がこれより変わったら「変わった」（0..255）

interface CellSignature {
  faces: { H: Mat3; layer?: FaceLayer; rgb: Float32Array }[]; // 面ごとに 9 マス × RGB
}

function cellColors(img: PixelSource, H: Mat3, layer: FaceLayer | undefined): Float32Array | null {
  const out = new Float32Array(27);
  for (let cell = 0; cell < 9; cell++) {
    const Hc = cellH({ H, layer }, cell);
    const r = Math.floor(cell / 3);
    const c = cell % 3;
    let n = 0;
    for (let i = 0; i < CHECK_POINTS; i++)
      for (let j = 0; j < CHECK_POINTS; j++) {
        const [x, y] = applyH(Hc, c + 0.3 + (0.4 * (j + 0.5)) / CHECK_POINTS, r + 0.3 + (0.4 * (i + 0.5)) / CHECK_POINTS);
        const xi = Math.round(x);
        const yi = Math.round(y);
        if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) return null;
        const k = (yi * img.width + xi) * 4;
        out[cell * 3] += img.data[k];
        out[cell * 3 + 1] += img.data[k + 1];
        out[cell * 3 + 2] += img.data[k + 2];
        n++;
      }
    for (let k = 0; k < 3; k++) out[cell * 3 + k] /= n;
  }
  return out;
}

// 精密に処理したフレームの面（3×3 の面だけ）の、マスの色の手がかり
function signatureOf(img: PixelSource, faces: { H: Mat3; held?: boolean; layer?: FaceLayer }[]): CellSignature | null {
  const out: CellSignature = { faces: [] };
  for (const f of faces) {
    if (f.held) continue;
    const rgb = cellColors(img, f.H, f.layer);
    if (!rgb) return null;
    out.faces.push({ H: f.H, layer: f.layer, rgb });
  }
  return out.faces.length ? out : null;
}

// img のマスの色が、基準 sig と同じか
export function sameCells(img: PixelSource, sig: CellSignature): boolean {
  for (const f of sig.faces) {
    const rgb = cellColors(img, f.H, f.layer);
    if (!rgb) return false;
    for (let k = 0; k < 27; k++) if (Math.abs(rgb[k] - f.rgb[k]) > CHECK_DIFF) return false;
  }
  return true;
}

export interface RefinedMove {
  move: number;
  orient: number;
  start: number; // 回し始め（ms）
  end: number; // 回し終わり（ms）
  inferred?: boolean;
  exact: boolean; // フレームから開始・終了を決められた
}

export interface RefineResult {
  moves: RefinedMove[];
  solved: boolean; // 最後に完成状態にたどり着いた
  start: number | null; // 最初の手の開始
  end: number | null; // 最後の手の終了
  frames: number;
  status: TrackStatus;
  inferred: number;
  forced: number; // 完成にたどり着くために最後に足した手の数（直接は見えていない）
  method?: string; // 再構成の方法（meet = 前後からつないだ / forward-finish / forward）
  startUncertain: boolean; // 最初の手が直接見えておらず、開始時刻をフレームから決められなかった
  endUncertain: boolean; // 最後の手が直接見えておらず、終了時刻をフレームから決められなかった
  raw?: { move: number; t0?: number; t: number; start: number; end: number; inferred?: boolean }[]; // まとめる前の手（調査用）
}

// 反対の面の層の動きを、タイムの端として採る範囲（それより離れた動きは別の手）
const OPPOSITE_WINDOW_MS = 250;

// moves[from] から dir の向きに続く同じ軸の手のまとまりに、両方の面の手があるか
function bothFacesAt(moves: { move: number }[], from: number, dir: 1 | -1): boolean {
  const face = moveFace(moves[from].move);
  for (let i = from + dir; i >= 0 && i < moves.length; i += dir) {
    const f = moveFace(moves[i].move);
    if (f === OPPOSITE[face]) return true;
    if (f !== face) return false;
  }
  return false;
}

// 重い設定: 全フレームを処理するので、1回の観測で起きる手は少ないが、取りこぼしを深く探し直せるように
export const REFINE_ENGINE: Partial<EngineOptions> = {
  decoder: { beamWidth: 64, maxMovesPerStep: 4, recoveryDepth: 5 },
  logMs: Infinity,
};

export class Refiner {
  readonly engine: TrackerEngine;
  private memory = {}; // フレームの間で引き継ぐもの（processFrame）
  private config: PipelineConfig;
  // 軽い検査
  private ref: CellSignature | null = null; // 最後に精密に処理したフレームのマスの色
  private lastFullT = -Infinity;
  private held: { img: PixelSource; t: number } | null = null; // 飛ばした直前のフレーム
  private tail = 0;
  gated = 0; // 軽い検査で飛ばしたフレームの数
  readonly patches: PatchFrame[] = [];
  readonly looks: { t: number; solved: boolean }[] = []; // フレームごとの「完成して見えるか」
  frames = 0;
  lastT = 0;
  method = "";

  constructor(
    private cv: CV,
    private input: RefineInput,
  ) {
    const opts = input.engine ?? {};
    this.engine = new TrackerEngine(Uint8Array.from(input.state), input.refs, {
      ...opts,
      decoder: { ...opts.decoder, ...REFINE_ENGINE.decoder },
      logMs: Infinity,
      keepObservations: true,
    }, input.orients);
    // ソルブ後の解析は時間をかけてよいので、二値化の窓を細かく試し、読めなかったマスは全部読み直す。
    // 直前のフレームのマーカーの周りだけで検出する（縁の近くに見つかったら全体でやり直す）
    this.config = { ...DEFAULT_PIPELINE, ...input.pipeline, arucoThorough: true, arucoRegion: true };
  }

  // 解析する範囲の終わりを決める（ソルブ中から解析していて、止めた時刻が分かったとき）
  setEnd(to: number): void {
    this.input.to = to;
  }

  // 区切り: 時刻 t に状態 target（フリーで完成したとき）だったと分かった。前の区切りからそこまでを前後から解き直し、
  // 以後はその状態から続ける。解き直した手順（それまでの区切りの手順を含む）を返す。つながらなければ null
  private seg: { state: CubeState; moves: DecodedMove[] } | null = null;
  checkpoint(t: number, target: CubeState): { t: number; state: number[]; orient: number; moves: DecodedMove[]; status: string } | null {
    const start = this.seg?.state ?? Uint8Array.from(this.input.state);
    const obs = this.engine.observationLog.filter((o) => o.t <= t);
    if (!obs.some((o) => o.faces.length)) return null;
    const off = decodeOffline(obs, start, target, t, { decoder: { ...this.input.engine?.decoder, ...DEFAULT_OFFLINE.decoder }, personal: this.input.engine?.personal });
    if (!off.reachedEnd) return null;
    const moves = simplifyMoves(off.moves);
    const orient = moves.length ? moves[moves.length - 1].orient : this.engine.decoder.best().orient;
    const full = [...(this.seg?.moves ?? []), ...moves];
    this.engine.rebase(target, orient, full, t, 0);
    this.seg = { state: Uint8Array.from(target), moves: full };
    return { t, state: Array.from(target), orient, moves: full, status: "tracking" };
  }

  // 途中結果: 前向きにここまで解いた最良の仮説（リアルタイムの追跡をこれに乗り換える）
  partial(): { t: number; state: number[]; orient: number; moves: DecodedMove[]; status: string } {
    const dec = this.engine.decoder;
    const best = dec.best();
    return { t: this.lastT, state: Array.from(best.state), orient: best.orient, moves: dec.bestMoves(), status: dec.status };
  }

  push(img: PixelSource, t: number): void {
    if (t < this.input.from || t > this.input.to) return;
    if (this.input.gate === false) return this.full(img, t);
    const forced = !this.ref || this.tail > 0 || t - this.lastFullT >= GATE_KEEP_MS;
    const changed = !this.ref || !sameCells(img, this.ref);
    if (!forced && !changed) {
      this.held = { img: copyImage(img, this.held?.img), t };
      this.gated++;
      return;
    }
    // 変わった: 変わる前の最後の 1 枚から精密に処理する
    if (changed && this.held) this.full(this.held.img, this.held.t);
    this.held = null;
    this.full(img, t);
    this.tail = changed ? GATE_TAIL : Math.max(0, this.tail - 1);
  }

  private full(img: PixelSource, t: number): void {
    const r = processFrame(this.cv, img, t, this.config, this.memory);
    this.ref = signatureOf(img, r.faces);
    this.lastFullT = t;
    const reading = { t, faces: r.faces.map((f) => ({ slot: f.slot, labs: f.labs, valid: f.valid, weight: f.weight, spread: f.spread, masked: f.masked, ids: f.ids })), turn: r.turn };
    this.engine.push(reading);
    this.looks.push({ t, solved: reading.faces.length > 0 && this.engine.looksSolved(reading) });
    this.patches.push({ t, faces: r.faces.map((f) => facePatch(img, { ...f, labs: f.labs })) });
    this.prunePatches(t);
    this.frames++;
    this.lastT = t;
  }

  // 画素のパッチ（1フレーム 10KB 程度）は、最初の手の前後と、直近の数秒（最後の手の前後）だけ残す
  private prunePatches(t: number): void {
    const hint = this.input.startHint;
    const P = this.patches;
    if (hint === undefined) {
      const keep = this.input.keepPatchesMs;
      if (keep !== undefined) {
        let k = 0;
        while (k < P.length && P[k].t < t - keep) k++;
        if (k > 30) P.splice(0, k);
      }
      return;
    }
    let i = 0;
    while (i < P.length && P[i].t <= hint + 1500) i++;
    let j = i;
    while (j < P.length && P[j].t < t - 3000) j++;
    if (j - i > 30) P.splice(i, j - i);
  }

  // m と同じ時刻・姿勢で、同じ軸の反対の面を回す手（その層の動きを調べるため）
  private opposite(m: { move: number; t0?: number; t: number; orient: number }) {
    return { move: OPPOSITE[moveFace(m.move)] * 3, t0: m.t0, t: m.t, orient: m.orient };
  }

  // target: 最後の状態が分かっていれば（タイマーなら完成）、それにたどり着く仮説を選ぶ
  result(target: CubeState | null = solvedState()): RefineResult {
    const dec = this.engine.decoder;
    // 前向き（スクランブル後から）と後ろ向き（完成から）の両方で解き直し、辻褄の合う所でつなぐ
    const off = decodeOffline(this.engine.observationLog, Uint8Array.from(this.input.state), target, this.lastT, {
      decoder: { ...this.input.engine?.decoder, ...DEFAULT_OFFLINE.decoder },
      personal: this.input.engine?.personal,
    });
    let moves = off.moves;
    let solved = target ? off.reachedEnd && isSolved(target) : isSolved(dec.best().state);
    let forced = off.method === "forward-finish" ? off.moves.filter((m) => m.inferred && m.t === this.lastT).length : 0;
    if (!off.reachedEnd) {
      // 再構成で終わりに届かなければ、リアルタイムと同じ前向きの結果に戻す
      moves = dec.bestMoves();
      solved = isSolved(dec.best().state);
      forced = 0;
      if (target && !statesEqual(dec.best().state, target)) {
        const fixed = dec.finish(target, this.lastT, 2);
        if (fixed) {
          forced = fixed.filter((m) => m.inferred && m.t === this.lastT).length;
          moves = fixed;
          solved = isSolved(target);
        }
      }
    }
    this.method = off.method;
    // 分かれて読まれた手をまとめ、打ち消し合う手（回転途中の見え方・指の誤読から出た雑音）を除く。状態は変わらない
    moves = simplifyMoves(moves);
    const timed = moves.map((m) => {
      const tm = this.engine.timing(m);
      return { ...m, start: tm?.start ?? m.t0 ?? m.t, end: tm?.end ?? m.t, exact: !!tm?.exact };
    });
    // タイムの両端は画素の差で詰める（色の読みより早く動きを拾える）
    const first = timed[0];
    const last = timed[timed.length - 1];
    let endUncertain = !!last?.inferred;
    // 最初の観測から既にスクランブルの状態と違う（解析の範囲より前に回し始めていた）: 開始は録画から決められない
    const firstObs = this.engine.observationLog.find((o) => o.faces.length);
    const beforeWindow = !!first && !!firstObs && (first.t0 ?? first.t) <= firstObs.t;
    const refs = this.engine.colors.refs;
    // 色の読みで静止フレームが見つからなかった（指で層が隠れていた）ときも、観測の時刻を手がかりに画素の差で探す
    if (first && !first.inferred) first.start = refineStart(this.patches, first, first.start, refs) ?? first.start;
    if (last && !last.inferred) last.end = refineEnd(this.patches, last, last.end, refs) ?? last.end;
    // 最初（最後）にある同じ軸の手のまとまりに両方の面の手があれば（D' U' など）、反対の面の層の動きも見る。
    // 同じ軸の手は順番を入れ替えても同じ状態になるので、間の状態が見えない（速い・指で隠れた）と「U D' U2」が
    // 「D' U'」と読まれ、本当は先に動いた U の層を見落とす。まとまりに反対の面の手がなければ、その層は動いていない
    if (first && !first.inferred && bothFacesAt(timed, 0, 1)) {
      const o = this.opposite(first);
      const tm = this.engine.timing(o);
      if (tm?.moved) {
        const s = refineStart(this.patches, o, tm.start, refs) ?? tm.start;
        if (s < first.start && s > first.start - OPPOSITE_WINDOW_MS) first.start = s;
      }
    }
    if (last && !last.inferred && bothFacesAt(timed, timed.length - 1, -1)) {
      const o = this.opposite(last);
      const tm = this.engine.timing(o);
      if (tm?.moved) {
        const e = refineEnd(this.patches, o, tm.end, refs) ?? tm.end;
        if (e > last.end && e < last.end + OPPOSITE_WINDOW_MS) last.end = e;
      }
    }
    if (last?.inferred && solved) {
      // 最後の手が見えていない（完成にたどり着くために足した手）: 直接見えた最後の手の後で、
      // 完成して見え始めたフレームを回し終わりとする
      const seen = [...timed].reverse().find((m) => !m.inferred);
      const after = seen ? seen.end : this.input.from;
      const i = this.looks.findIndex((x, k) => x.t > after && x.solved && this.looks[k + 1]?.solved !== false);
      if (i > 0) {
        last.end = (this.looks[i - 1].t + this.looks[i].t) / 2;
        last.start = Math.min(last.start, last.end);
        endUncertain = false;
      }
    }
    const merged = mergeQuickRepeats(timed).map((m) => ({ move: m.move, orient: m.orient, start: m.start, end: Math.max(m.start, m.end), exact: m.exact, ...(m.inferred ? { inferred: true } : {}) }));
    return {
      moves: merged,
      solved,
      start: merged.length ? merged[0].start : null,
      end: merged.length ? merged[merged.length - 1].end : null,
      frames: this.frames,
      status: dec.status,
      inferred: merged.filter((m) => m.inferred).length,
      forced,
      method: this.method,
      startUncertain: !!first?.inferred || beforeWindow,
      endUncertain,
      raw: timed.map((m) => ({ move: m.move, t0: m.t0, t: m.t, start: m.start, end: m.end, inferred: m.inferred })),
    };
  }
}

// 画素を写す（飛ばしたフレームを取っておく。古いものの入れ物を使い回す）
function copyImage(img: PixelSource, reuse?: PixelSource): PixelSource {
  const data = reuse && reuse.data.length === img.data.length ? (reuse.data as Uint8ClampedArray) : new Uint8ClampedArray(img.data.length);
  data.set(img.data);
  return { data, width: img.width, height: img.height } as PixelSource;
}

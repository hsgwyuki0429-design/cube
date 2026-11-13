// ソルブ後の精密解析: 録画した全フレームを1枚ずつ、リアルタイムより重い設定で認識・追跡し直す。
// 手順と、各手の開始・終了時刻（フレームの記録から求めた、誤差はフレーム間隔の半分程度）を出す。
// OpenCV のオブジェクトは呼び出し側が渡すので、Worker でもテスト（Node）でも同じコードが動く。
import { type CubeState, OPPOSITE, isSolved, moveFace, solvedState, statesEqual } from "../cube/model";
import { type EngineOptions, TrackerEngine } from "../track/engine";
import { mergeQuickRepeats, separateMotions, simplifyMoves } from "../track/merge";
import { type Sighting, decodeExact, verifyMoves } from "../track/exact";
import { DEFAULT_OFFLINE, OfflineForward, type OfflineOptions, decodeOffline, finishDeep } from "../track/offline";
import type { DecodedMove, TrackStatus } from "../track/types";
import type { Lab } from "./color";
import { type PatchFrame, facePatch, refineEnd, refineStart } from "./fineTiming";
import type { CV, PixelSource } from "./image";
import { DEFAULT_PIPELINE, type FrameResult, type PipelineConfig, frameReading, processFrame } from "./pipeline";
import { type FaceLayer, cellH } from "../aruco/cube";
import type { Marker } from "../aruco/detect";
import { type DetectHint, detectHint } from "./arucoFrame";
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
  // インスペクションの終わり（回し始めの少し前、ms）。録画全体を解析するとき（止まった後のやり直し）、これより前のフレームはソルブ中から
  // 進める解析と同じく間引く（vision.worker.ts の INSPECT_EVERY_MS）。インスペクションで回して見せている間を全部処理すると、持ち替えを
  // 手と読み違えて完成までつながらないことがあった（録画の画質の実物のソルブ 2 本）
  inspectUntil?: number;
  // 確認役（src/track/exact.ts）: 解き直した手順を、フレームの読み（どのステッカーがいつどのマスに見えたか）から確かな所を埋めた
  // 手順と照らし、食い違う手・1 通りに決まらない手を推定にする（既定 true。終わりの状態が分かっているときだけ）
  verify?: boolean;
}

// 確認役に使う時間の上限（ms）。実物のソルブで Node 1〜13 秒（原画質・5Mbps）、30〜45 秒（2.5Mbps）。超えたら確かめられなかったとする
const VERIFY_MS = 60000;

// 軽い検査: 全フレームを精密に処理する代わりに、前に精密に処理したフレーム（基準）の面の格子で、各マスの真ん中あたりの色を数点だけ測り
// （CHECK_POINTS × CHECK_POINTS 点の平均。1 フレーム 0.1ms 程度）、基準と同じなら飛ばす。層を回す・持ち替える・指が動く・キューブが
// 揺れて格子からずれると色が変わるので精密に処理する（迷ったら精密に。読み違えて飛ばすことはない向き）。
// 変わっていたら、取っておいた直前のフレーム（変わる前の最後の 1 枚。回し始めの時刻に要る）と、そのフレームを精密に処理し、
// その後 GATE_TAIL 枚も精密に処理する（回し終わりの時刻は、止まった後のフレームでも止まっていることを確かめる）。GATE_KEEP_MS ごとにも精密に
// （ライブ並みの認識を軽い検査にすると、精密な処理の 7 割ほどかかり、飛ばしても全体では遅くなった）
const GATE_KEEP_MS = 200;
const GATE_TAIL = 2;
const CHECK_POINTS = 5;
const CHECK_DIFF = 25; // マスの色（25 点の R・G・B の平均）の差の最大がこれより大きければ「変わった」（0..255）

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
        const [x, y] = applyH(Hc, c + 0.15 + (0.7 * (j + 0.5)) / CHECK_POINTS, r + 0.15 + (0.7 * (i + 0.5)) / CHECK_POINTS);
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

// 基準の格子のまま、マスの色を img で測り直す（並列のとき: 格子は最後に処理し終えたフレーム、色は最後に処理に回したフレーム）
function resample(img: PixelSource, sig: CellSignature): CellSignature | null {
  const faces: CellSignature["faces"] = [];
  for (const f of sig.faces) {
    const rgb = cellColors(img, f.H, f.layer);
    if (!rgb) return null;
    faces.push({ ...f, rgb });
  }
  return { faces };
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
  method?: string; // 再構成の方法（meet = 前後からつないだ / backward = 後ろ向きだけ / forward-finish / forward）
  // 始まりの状態が渡されたものと違っていた（スクランブルを間違えて回していた）: 完成から後ろ向きにたどり着いた始まりの状態。
  // moves はこの状態から完成まで
  startState?: number[];
  // 完成までつながらなかった（solved = false）が、終わりの時刻は後ろ向きに追えた最後の手から決めた（タイムは出せる）
  gapped?: boolean;
  startUncertain: boolean; // 最初の手が直接見えておらず、開始時刻をフレームから決められなかった
  endUncertain: boolean; // 最後の手が直接見えておらず、終了時刻をフレームから決められなかった
  raw?: { move: number; t0?: number; t: number; start: number; end: number; inferred?: boolean }[]; // まとめる前の手（調査用）
  // 確認役: 同じ手順だった（true）・違った（false）・確かめられなかった（null）。verifyMarked: 確認役で推定にした手の数
  verified?: boolean | null;
  verifyMarked?: number;
}

const EDGE_NOISE_MAX = 8; // 最初・最後の「それだけで打ち消し合う手の並び」として除く長さの上限
// まとめる前の端の手の観測が、まとめた後の端の手の時刻からこれより外なら、その手の時刻をフレームから決められないときタイムの端を不確かにする
const RAW_SLACK_MS = 100;

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

// 重い設定: 全フレームを処理するので、1回の観測で起きる手は少ないが、取りこぼしを探し直せるように。見失ったときの探し直しは
// 4 手まで（5 手は手順の木が 65 万節点になり、1 回でメモリを 100MB 近く使っていた。手順は decodeOffline が前後から解き直して決める
// ので、こちらの探し直しは結果にほとんど効かない）
export const REFINE_ENGINE: Partial<EngineOptions> = {
  decoder: { beamWidth: 64, maxMovesPerStep: 4, recoveryDepth: 4 },
  logMs: Infinity,
};

// 精密解析の認識の設定（RefineInput.pipeline で上書きできる）。二値化の窓はライブと同じ 3 通り（5〜15）、読めなかったマスは OpenCV で
// 読み直さずに格子で読む（src/aruco/gridRead.ts）。合成の 10 手 × 10 本（速い回し方）で、手順・タイムの端の誤差は窓 4 通り + 読み直しと
// 同じで、1 フレーム 67 → 42ms（読み直しが 1 フレームの 3 割、4 つ目の窓が 2 割）。1 フレームの色が正しく分かるマスは 65.5 → 64.2%
// （指で半分以上隠れたマスの読み直しの分。手順には効いていなかった）
export const REFINE_PIPELINE: Partial<PipelineConfig> = { arucoReread: 0, arucoGrid: true, arucoFineWindows: false };

// 解き直しの後ろ向きに使う時間の上限（src/track/offline.ts の backwardMs）。実物のソルブを本体の録画の画質（720p・2.5Mbps）にすると、後ろ向きが
// 見失ったまま全観測を探して Node で 8 秒（iPhone では 2〜3 倍）かかった。超えたら、そこまでの後ろ向きでつなぐ・橋渡しする
const BACKWARD_MS = 30000;
// 1 回目の解き直しで前後がつながらなかった（橋渡し・前向きを補った・届かない）ときの 2 回目: 同じ観測を、1 観測 4 手まで・候補 256 で
// 解き直す（観測は残っているのでフレームは処理し直さない）。録画の画質の実物のソルブで、1 回目は 6 手を推定でつなぐ・終わりを補うだけ
// だったものが、どちらも推定 0 手で完成までつながった（88 手は正解と同じ）。4 手まででも候補 64 では前向きが見失って悪くなる。
// Node で 15〜25 秒かかるので、1 回目でつながったときは使わない
const DEEP_DECODER = { beamWidth: 256, maxMovesPerStep: 4 };
const DEEP_BACKWARD_MS = 60000;

export class Refiner {
  readonly engine: TrackerEngine;
  private memory = {}; // フレームの間で引き継ぐもの（processFrame）
  private config: PipelineConfig;
  // 軽い検査
  private ref: CellSignature | null = null; // 最後に精密に処理したフレームのマスの色
  private lastGateT = -Infinity; // 最後に精密に処理すると決めたフレーム
  private held: { img: PixelSource; t: number } | null = null; // 飛ばした直前のフレーム
  private tail = 0;
  private picked: { img: PixelSource; t: number } | null = null; // 最後に精密な処理に回したフレーム
  gated = 0; // 軽い検査で飛ばしたフレームの数
  readonly patches: PatchFrame[] = [];
  readonly looks: { t: number; solved: boolean }[] = []; // フレームごとの「完成して見えるか」
  frames = 0;
  lastT = 0;
  method = "";
  // 前向きの再構成を観測が出るたびに進めておく（result で後ろ向きとつなぐだけにする）
  private forward: OfflineForward | null;
  private fedObs = 0;
  // 確認役に渡すフレームの読み（面ごとに 9 マスの ID と、マーカーを直接読んだか。1 フレーム数十バイト）
  private sightings: Sighting[] = [];

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
      repeatMs: 0,
    }, input.orients);
    this.forward = input.keepPatchesMs === undefined ? new OfflineForward(Uint8Array.from(input.state), this.offlineOptions()) : null;
    // ソルブ後の解析は時間をかけてよいので、二値化の窓を細かく試し、読めなかったマスは全部読み直す。
    // 直前のフレームのマーカーの周りだけで検出する（縁の近くに見つかったら全体でやり直す）
    this.config = { ...DEFAULT_PIPELINE, ...REFINE_PIPELINE, ...input.pipeline, arucoThorough: true, arucoRegion: true };
  }

  // インスペクションの終わり（リアルタイムが回し始めたと判定した少し前）。それより前のフレームは間引いて渡されている
  // （vision.worker.ts の INSPECT_*）ので、その間に読めた「打ち消し合って消えた手」（持ち替えの読み違い）はタイムの端に使わない。
  // 打ち消されずに残った最初の手がその間にあれば、リアルタイムが回し始めを遅く判定しただけなので、その手の回し始めをそのまま使う
  // （実物のソルブで、最初の F は本当にリアルタイムの開始の 0.7 秒前に回していた。以前はその後の手の回し始めに直して不確かにしていた）
  private inspectUntil = -Infinity;
  setInspectUntil(t: number): void {
    this.inspectUntil = t;
  }

  // 解析する範囲の終わりを決める（ソルブ中から解析していて、止めた時刻が分かったとき）
  setEnd(to: number): void {
    this.input.to = to;
  }

  private offlineOptions(): OfflineOptions {
    return { decoder: { ...this.input.engine?.decoder, ...DEFAULT_OFFLINE.decoder }, personal: this.input.engine?.personal, backwardMs: BACKWARD_MS };
  }

  // 途中結果: 前向きにここまで解いた最良の仮説（遅れの表示用。ライブの追跡には反映しない）
  partial(): { t: number; state: number[]; orient: number; moves: DecodedMove[]; status: string } {
    const dec = this.engine.decoder;
    const best = dec.best();
    return { t: this.lastT, state: Array.from(best.state), orient: best.orient, moves: dec.bestMoves(), status: dec.status };
  }

  push(img: PixelSource, t: number): void {
    for (const f of this.gate(img, t)) this.full(f.img, f.t);
  }

  // 軽い検査: このフレームで精密に処理するもの（0〜2 枚。時刻順）。飛ばすフレームは取っておく（変わったときに直前の 1 枚として処理する）。
  // 検出を別の Worker で並列にするときは、返ったフレームを検出してから順に full に渡す（基準は最後に処理し終えたフレーム）
  gate(img: PixelSource, t: number): { img: PixelSource; t: number }[] {
    if (t < this.input.from || t > this.input.to) return [];
    if (this.input.gate === false) return [{ img, t }];
    const forced = !this.ref || this.tail > 0 || t - this.lastGateT >= GATE_KEEP_MS;
    const changed = !this.ref || !sameCells(img, this.ref);
    if (!forced && !changed) {
      this.held = { img: copyImage(img, this.held?.img), t };
      this.gated++;
      return [];
    }
    // 変わった: 変わる前の最後の 1 枚から精密に処理する
    const out = changed && this.held ? [this.held] : [];
    this.held = null;
    out.push({ img, t });
    this.tail = changed ? GATE_TAIL : Math.max(0, this.tail - 1);
    this.lastGateT = t;
    // 検出を並列にすると、処理し終える前に次のフレームが来る。基準の色を、処理に回したこのフレームのものにしておく
    // （古いフレームの色と比べると、変わった後の数枚が「変わった」と出続けて、止まっていても飛ばせなかった）
    this.picked = { img, t };
    if (this.ref) this.ref = resample(img, this.ref);
    return out;
  }

  get pipelineConfig(): PipelineConfig {
    return this.config;
  }

  // 精密に処理したフレームの結果（調査用: tests/debug/realVideo.debug.test.ts）
  onFrame?: (t: number, r: FrameResult) => void;

  // 次に検出するフレームの切り出し（別の Worker で検出するとき。最後に処理し終えたフレームのマーカーの範囲から）
  detectHint(img: PixelSource, t: number): DetectHint | null {
    return this.config.arucoRegion ? detectHint(this.memory, img, t) : null;
  }

  // 精密に処理する。detected: 別の Worker で検出しておいたマーカー
  full(img: PixelSource, t: number, detected?: Marker[]): void {
    const r = processFrame(this.cv, img, t, this.config, this.memory, detected);
    this.onFrame?.(t, r);
    // 基準: この格子で、処理に回したいちばん新しいフレームの色（1 か所で処理するときは、このフレーム）
    const latest = this.picked && this.picked.t > t ? this.picked.img : img;
    // 見えている面が減ったフレーム（回している途中・指）の後は、続けて精密に処理する: 残った面だけを基準にすると、回している面
    // そのもの（揃った面は回しても真ん中あたりの色が変わらない）だけが残ったとき、回している間のフレームを「同じ」とみて飛ばす
    const before = this.ref?.faces.length ?? 0;
    this.ref = signatureOf(latest, r.faces);
    if ((this.ref?.faces.length ?? 0) < before) this.tail = Math.max(this.tail, GATE_TAIL);
    if (this.input.verify !== false)
      this.sightings.push({ t, faces: r.faces.map((f) => ({ slot: f.slot, ids: Int8Array.from(f.ids ?? new Array(9).fill(-1)), w: Uint8Array.from(f.weight, (w) => (w >= 0.85 ? 1 : 0)) })) });
    const reading = frameReading(t, r);
    this.engine.push(reading);
    if (this.forward) {
      const log = this.engine.observationLog;
      for (; this.fedObs < log.length; this.fedObs++) this.forward.feed(log[this.fedObs]);
    }
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
  // onPhase: 段階を知らせる（解き直しの後に "timing"。落ちたときにどこで落ちたかを残すため: src/app/crashGuard.ts）。解き直しの間も
  // "decode" をときどき（呼ぶ側で間引く）: 本体は知らせが届かないと止まったとみなしてやり直す（controller.endAnalysis の STALL_MS）
  deepUsed = false; // 調査用: 2 回目の深い解き直しの結果を使った
  result(target: CubeState | null = solvedState(), onPhase?: (phase: "decode" | "timing") => void): RefineResult {
    const dec = this.engine.decoder;
    const tick = onPhase ? () => onPhase("decode") : undefined;
    // 前向き（スクランブル後から）と後ろ向き（完成から）の両方で解き直し、辻褄の合う所でつなぐ
    let off = decodeOffline(this.engine.observationLog, Uint8Array.from(this.input.state), target, this.lastT, { ...this.offlineOptions(), tick }, this.forward ?? undefined);
    if (target && off.method !== "meet" && off.method !== "backward") {
      const base = this.offlineOptions();
      const deep = decodeOffline(this.engine.observationLog, Uint8Array.from(this.input.state), target, this.lastT, { ...base, decoder: { ...base.decoder, ...DEEP_DECODER }, backwardMs: DEEP_BACKWARD_MS, tick });
      const guessed = (r: typeof off) => r.moves.filter((m) => m.inferred).length;
      if (deep.reachedEnd && (!off.reachedEnd || guessed(deep) < guessed(off) || (guessed(deep) === guessed(off) && deep.method === "meet"))) off = deep;
      this.deepUsed = off === deep;
    }
    let moves = off.moves;
    let solved = target ? off.reachedEnd && isSolved(target) : isSolved(dec.best().state);
    let forced = off.method === "forward-finish" ? off.moves.filter((m) => m.inferred && m.t === this.lastT).length : 0;
    if (!off.reachedEnd) {
      // 再構成で終わりに届かなければ、リアルタイムと同じ前向きの結果に戻す
      moves = dec.bestMoves();
      solved = isSolved(dec.best().state);
      forced = 0;
      if (target && !statesEqual(dec.best().state, target)) {
        const fixed = finishDeep(dec, target, this.lastT, tick);
        if (fixed) {
          forced = fixed.filter((m) => m.inferred && m.t === this.lastT).length;
          moves = fixed;
          solved = isSolved(target);
        }
      }
    }
    // 確認役: 完成までつながった手順を、フレームの読みから確かな所を埋めた手順と照らす（食い違う手・決まらない手を推定に）
    let verified: boolean | null | undefined;
    let verifyMarked: number | undefined;
    if (target && solved && this.input.verify !== false && this.sightings.length) {
      const begin = off.startState ? Uint8Array.from(off.startState) : Uint8Array.from(this.input.state);
      const ex = decodeExact(this.sightings, begin, target, { budgetMs: VERIFY_MS, tick });
      const v = verifyMoves(moves, ex);
      moves = v.moves;
      verified = v.agreed;
      verifyMarked = v.marked;
    }
    this.method = off.method;
    // 届かなかったとき、後ろ向きが終わりから追えていた最後の手（タイムの終わりに使う）
    const tailLast = !solved && off.tail?.length ? off.tail[off.tail.length - 1] : null;
    onPhase?.("timing");
    const timeOf = <T extends DecodedMove>(m: T) => {
      const tm = this.engine.timing(m);
      return { ...m, start: tm?.start ?? m.t0 ?? m.t, end: tm?.end ?? m.t, exact: !!tm?.exact, endExact: !!tm?.endExact, moved: !!tm?.moved };
    };
    // 分かれて読まれた手をまとめ、打ち消し合う手（回転途中の見え方・指の誤読から出た雑音）を除く。状態は変わらない。
    // ただし、どちらも層が動いたのを見つけていて間で止まっていた 2 手は、本当に回した手（無駄な動きも）として残す（separateMotions）
    // 最初・最後にある、それだけで打ち消し合って消える手の並び（U U' など）は、回し始める前・完成した後の読み違い（持ち替えを
    // 手として読んだ）なので除く: 回し始める前は始まりの状態のまま、完成した後は完成のまま。残すと、どちらも「層が動いたのを見た」
    // ときに本当に回した無駄な動きとして残り、タイムの端がそこまで延びる（実物のソルブで、完成した後にキューブを持ち替えた所まで
    // 終わりが 0.25 秒延びた。認識が少し変わるだけで出たり出なかったりした）
    const cancels = (ms: DecodedMove[]) => ms.length > 0 && simplifyMoves(ms).length === 0;
    let lead = 0;
    for (let j = Math.min(moves.length, EDGE_NOISE_MAX); j >= 2 && !lead; j--) if (cancels(moves.slice(0, j))) lead = j;
    let trail = 0;
    for (let j = Math.min(moves.length - lead, EDGE_NOISE_MAX); j >= 2 && !trail; j--) if (cancels(moves.slice(moves.length - j))) trail = j;
    if (lead || trail) moves = moves.slice(lead, moves.length - trail);
    const raw = moves;
    const timings = new Map<DecodedMove, ReturnType<typeof timeOf>>();
    const timed0 = (m: DecodedMove) => {
      let r = timings.get(m);
      if (!r) timings.set(m, (r = timeOf(m)));
      return r;
    };
    moves = simplifyMoves(moves, (a, b) => separateMotions(timed0(a), timed0(b)));
    const timed = moves.map(timeOf);
    // タイムの両端は画素の差で詰める（色の読みより早く動きを拾える）
    const first = timed[0];
    const last = timed[timed.length - 1];
    // まとめる前の端の手: 打ち消し合って消えた手（F2 B2 F2 → B2 の最後の F2）も実際に回しているので、タイムはその手の端まで。
    // 層が見えて動いたのをフレームから見つけた手だけ（そうでなければ誤読の雑音かもしれないので、まとめた後の端の手のまま。
    // インスペクション中・完成した後の誤読を打ち消し合う 2 手で説明した仮説の手で、タイムが長くなっていた）
    let rawStart = false;
    let rawEnd = false;
    // まとめる前の端の手の時刻をフレームから決められず、まとめた後の端の手より RAW_SLACK_MS より外にありそうなら、タイムの端は
    // 不確か（F2 B2 F2 → B2 で、最後の F2 を回している間は正面が読めなかった: B2 の終わりを「確定」にすると 276ms 短かった）
    let rawStartUnsure = false;
    let rawEndUnsure = false;
    if (first && raw[0] && raw[0] !== moves[0] && !raw[0].inferred && raw[0].t >= this.inspectUntil) {
      const r = timeOf(raw[0]);
      if (r.exact && r.moved && r.start < first.start) {
        Object.assign(first, { start: refineStart(this.patches, r, r.start, this.engine.colors.refs) ?? r.start, exact: true });
        rawStart = true;
      } else if (!(r.exact && r.moved) && (raw[0].t0 ?? raw[0].t) < first.start - RAW_SLACK_MS) rawStartUnsure = true;
    }
    if (last && raw.length && raw[raw.length - 1] !== moves[moves.length - 1] && !raw[raw.length - 1].inferred) {
      const r = timeOf(raw[raw.length - 1]);
      if (r.exact && r.endExact && r.moved && r.end > last.end) {
        Object.assign(last, { end: refineEnd(this.patches, r, r.end, this.engine.colors.refs) ?? r.end, endExact: true });
        rawEnd = true;
      } else if (!(r.endExact && r.moved) && raw[raw.length - 1].t > last.end + RAW_SLACK_MS) {
        rawEndUnsure = true;
        last.end = Math.max(last.end, raw[raw.length - 1].t);
      }
    }
    let endUncertain = !!last?.inferred;
    // 最初の観測から既にスクランブルの状態と違う（解析の範囲より前に回し始めていた）: 開始は録画から決められない
    const firstObs = this.engine.observationLog.find((o) => o.faces.length);
    const beforeWindow = !!first && !!firstObs && (first.t0 ?? first.t) <= firstObs.t;
    const refs = this.engine.colors.refs;
    // 色の読みで静止フレームが見つからなかった（指で層が隠れていた）ときも、観測の時刻を手がかりに画素の差で探す
    if (first && !first.inferred && !rawStart) {
      const s = refineStart(this.patches, first, first.start, refs);
      if (s !== null) Object.assign(first, { start: s, exact: true });
    }
    if (last && !last.inferred && !rawEnd) {
      const e = refineEnd(this.patches, last, last.end, refs);
      if (e !== null) Object.assign(last, { end: e, endExact: true });
    }
    // 最初（最後）にある同じ軸の手のまとまりに両方の面の手があれば（D' U' など）、反対の面の層の動きも見る。
    // 同じ軸の手は順番を入れ替えても同じ状態になるので、間の状態が見えない（速い・指で隠れた）と「U D' U2」が
    // 「D' U'」と読まれ、本当は先に動いた U の層を見落とす。まとまりに反対の面の手がなければ、その層は動いていない
    if (first && !first.inferred && !rawStart && bothFacesAt(timed, 0, 1)) {
      const o = this.opposite(first);
      const tm = this.engine.timing(o);
      if (tm?.moved) {
        const s = refineStart(this.patches, o, tm.start, refs) ?? tm.start;
        if (s < first.start && s > first.start - OPPOSITE_WINDOW_MS) Object.assign(first, { start: s, exact: true });
      }
    }
    if (last && !last.inferred && !rawEnd && bothFacesAt(timed, timed.length - 1, -1)) {
      const o = this.opposite(last);
      const tm = this.engine.timing(o);
      if (tm?.moved) {
        const e = refineEnd(this.patches, o, tm.end, refs) ?? tm.end;
        if (e > last.end && e < last.end + OPPOSITE_WINDOW_MS) Object.assign(last, { end: e, endExact: true });
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
    // 完成までつながらなかった: 終わりの時刻は、後ろ向きに追えた最後の手の回し終わり（フレームから決まったときだけ確か）
    let gapEnd: number | null = null;
    let gapEndSure = false;
    if (tailLast) {
      const r = timeOf(tailLast);
      const e = tailLast.inferred ? null : refineEnd(this.patches, tailLast, r.end, refs);
      gapEnd = e ?? r.end;
      gapEndSure = !tailLast.inferred && (e !== null || r.endExact);
    }
    const merged = mergeQuickRepeats(timed, undefined, undefined, separateMotions).map((m) => ({ move: m.move, orient: m.orient, start: m.start, end: Math.max(m.start, m.end), exact: m.exact, ...(m.inferred ? { inferred: true } : {}) }));
    return {
      moves: merged,
      solved,
      start: merged.length ? merged[0].start : null,
      end: gapEnd ?? (merged.length ? merged[merged.length - 1].end : null),
      ...(gapEnd !== null ? { gapped: true } : {}),
      ...(off.startState ? { startState: Array.from(off.startState) } : {}),
      frames: this.frames,
      status: dec.status,
      inferred: merged.filter((m) => m.inferred).length,
      forced,
      method: this.method,
      // 端の手の層が見えず、時刻をフレームから決められなかった（観測の時刻のまま）ときも不確か。見えない層（低く構えて U・B が
      // 写らないなど）の手は、観測の時刻が数百 ms ずれることがある
      startUncertain: !!first?.inferred || beforeWindow || !first?.exact || rawStartUnsure,
      endUncertain: gapEnd !== null ? !gapEndSure : endUncertain || (!!last && !last.inferred && !last.endExact) || rawEndUnsure,
      raw: timed.map((m) => ({ move: m.move, t0: m.t0, t: m.t, start: m.start, end: m.end, inferred: m.inferred })),
      ...(verified !== undefined ? { verified, verifyMarked } : {}),
    };
  }
}

// 画素を写す（飛ばしたフレームを取っておく。古いものの入れ物を使い回す）
function copyImage(img: PixelSource, reuse?: PixelSource): PixelSource {
  const data = reuse && reuse.data.length === img.data.length ? (reuse.data as Uint8ClampedArray) : new Uint8ClampedArray(img.data.length);
  data.set(img.data);
  return { data, width: img.width, height: img.height } as PixelSource;
}

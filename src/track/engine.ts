// 追跡エンジン: フレームの読み取り → 安定観測 → デコーダ → 結果。カメラも DOM も知らない。
// Worker の中でもテストの中でも同じコードが動く。
import { type RecoverOptions, orientsOf, recoverFrom } from "./recover";
import { type CubeState, NORMAL, VIEW, applyMove, faceletGeometry, inverseMove, isSolved, moveFace, solvedState } from "../cube/model";
import { stickerIdAt } from "../cube/stickers";
import type { Lab } from "../vision/color";
import { ColorModel, type ColorModelOptions } from "./colorModel";
import { type DecoderOptions, type Hypothesis, MoveDecoder, observationCost } from "./decoder";
import { movePrior } from "./prior";
import { snapToObservation } from "./snap";
import { FaceObserver, type FrameReading, type ObserverOptions } from "./observer";
import { DEFAULT_TIMING, type LoggedFrame, type MoveTiming, moveTiming } from "./timing";
import { OrientTracker, type OrientOptions } from "./orient";
import type { SightFrame } from "./sight";
import { LiveState, type LiveStateOptions, liveFrame, warmLiveTables } from "./liveState";
import type { DecodedMove, Observation, OrientHint, TrackStatus, TurnHint, TurnSnapshot } from "./types";

export interface EngineOptions {
  decoder: Partial<DecoderOptions>;
  observer: Partial<ObserverOptions>;
  colors: Partial<ColorModelOptions>;
  logMs: number; // 手の正確な時刻を求めるために残すフレームの記録（ms。Infinity で全部）
  keepObservations?: boolean; // 観測をすべて残す（ソルブ後の再構成で、前後両方向から解き直すため）
  maxObservations?: number; // 残す観測の数の上限（リアルタイムの追跡で、精密解析への乗り換えに使う分だけ）
  personal?: number[][]; // 自分のソルブの手順（手順の知識に加える）
  // 最良の仮説でも観測と合わない（コスト REPEAT_COST 以上）まま同じ読みが続いたら、この間隔で観測を出し直す（0 で出し直さない）。
  // 観測は読みが変わったときしか出ないので、見えにくい面の少しのマスでしか分からない手（1 手のコストと手順の知識の上乗せより
  // 矛盾が少し安い）を、いつまでも足さなかった。誤読は長く続かないが、本当の変化は続くので、続いた分だけ矛盾を重ねる。
  // 精密解析は全部の観測をまとめて解き直すので使わない
  repeatMs?: number;
  // ライブ: 一番合う仮説でも見え方とはっきり合わなければ、見えている色に合う状態にその場で作り変え、そこから追跡をやり直す
  // （src/track/snap.ts。3D を見えているキューブと同じ色の組み合わせに保つ。精密解析は使わない）
  snapToView?: boolean;
  // 見失ったところからの復帰（ライブ）: 見失う直前の確かな状態から、後で読めたステッカーが全部合う手順を探して仮説に足す（src/track/recover.ts）
  recover?: boolean | Partial<RecoverOptions>;
  // キューブ全体の向きを手とは別に追う（ライブ。src/track/orient.ts）: 前後のフレームで同じ面を突き合わせ、観測ごとに前の観測から
  // 動いていないステッカーをデコーダに渡す（デコーダの trackedOrient で使う）。push に見え方（sight）を渡したときだけ外枠を使える
  orient?: boolean | Partial<OrientOptions>;
  // ソルブ中のライブの状態の推定（ライブ 2 の後半。src/track/liveState.ts）: 有効にした時点の一番合う仮説の状態と手順から、ピース 20 個と
  // センターの向きを表の AND で推定する（観測器・デコーダ・作り変え・復帰は止める）。無効にすると、その時点の状態と手順をデコーダに戻す。
  // controller はタイマーの計測中だけ有効にする（スクランブル中・インスペクション・開始と停止の判定は今までの追跡のまま）
  pieces?: boolean | Partial<LiveStateOptions>;
}


const TIMING_FINAL_MS = 1000;
const LIVE_EMIT_MS = 100; // ソルブ中のライブの状態の推定: 手順も状態も変わらないときに TrackUpdate を出す間隔 // 手の観測からこれだけたてば、その手の時刻はもう変わらない
const REPEAT_COST = 0.8;
// 作り変え（ライブは見えているキューブにどんどん合わせる）: 最良の仮説の観測の矛盾がこれ以上（1 マスの色の矛盾 1.5）の観測が
// 2 回続いたら、SNAP_NOW 以上なら（2 マス以上）すぐ、見えている色に合う状態を 3D に出す。作り変えた状態が観測をこれだけ以上よく
// 説明するときだけ。矛盾が 2 観測続いたら（OVERWRITE_STREAK）、その状態を追跡の仮説に足し、一番にしてそこから追う（元の仮説も
// 残すので、誤読が続かなければ元の仮説に戻る。追跡ごと置き換えていた間は、実物の T-perm 2 回で手順は合っているのに最後の状態が
// 揃っていなかった。以前は見失ったときだけ上書きし、それまでは 3D だけ作り変えていて、3D とずれたままのことがあった）
const SNAP_COST = 1.4;
const SNAP_NOW = 2.9;
const SNAP_GAIN = 1.0;
const OVERWRITE_STREAK = 2;
const SOLVED_FACE_CELLS = 6; // 揃った状態の仮説を足すのに要る、1 面の読めたマスの数（2 面以上）
// 見失ったところからの復帰（recover）: 錨にする仮説の観測のコストの上限・錨から探す時間の上限（8 手で届く間）・試す間隔・足した仮説を
// 一番より安くする分
const ANCHOR_COST = 0.5;
const RECOVER_MS = 2500;
const RECOVER_GAP_MS = 100;
const RECOVER_BONUS = 0.3;
const INJECT_COST = 0.5; // 作り変えた仮説を足すときの上乗せ（観測をよく説明する分 SNAP_GAIN より小さいので、足した時点では一番になる）
const MAX_REPEATS = 2; // 同じ読みで出し直す回数の上限（指で隠れたままの誤読を重ねすぎない）

export interface TrackUpdate {
  status: TrackStatus;
  moves: DecodedMove[]; // 最良仮説の手順（開始から）
  confirmed: number; // 先頭から何手目までが確定か
  state: number[]; // 最良仮説のキューブ状態
  orient: number;
  solved: boolean;
  margin: number;
  obsCost: number;
  observations: number;
  recoveries: number;
  refs: Lab[]; // 適応後の代表色
  observation: { t: number; faces: { slot: number; labels: number[] }[] };
  timings: (MoveTiming | null)[]; // moves と同じ並び。フレームの記録から求めた開始・終了時刻（記録が残っていなければ null）
  cells: CellBelief; // マスごとの確からしさ（不確実性の保持）
  // ライブの作り変え（snapToView）: 何回目か・そのときの手の数・作り変えた状態（キューブ固定）。手順は作り変えの前後でつながらない
  // （moves の at 番目より前の手を始まりの状態に当てても state にならない）。3D はこの状態から、at 番目以降の手を回す
  base: { n: number; at: number; state: number[]; t: number } | null;
  // ライブの表示だけの作り変え: 追跡（最良の仮説）では見え方をはっきり説明できない間、3D に出す見えている色に合う状態（null = 最良の仮説）
  view: { n: number; state: number[]; orient: number; t: number } | null;
  // ライブの状態の推定（EngineOptions.pieces）: 候補の状態がどれも同じ手順で説明できる手の数（3D で層を回して見せてよいのはこれより前の手だけ。
  // ほかは塗り替える）。今までの追跡では出さない
  agreed?: number;
}

// マスごとの確からしさ。添え字はキューブ固定の facelet（最良の仮説の状態の並び）。
// 「そこにあるステッカー」を無理に 1 つに決めず、有力な仮説どうしの食い違い・最後に直接見た時刻・最後に動かした時刻を残す。
//   未確定: certainty < CERTAIN（仮説によって別のステッカーがある）
//   推定: 最後に見たより後に動かした（動かした手が直接見えていない・見えていない面に移った）
export interface CellBelief {
  certainty: number[]; // 有力な仮説（コスト差 BELIEF_MARGIN 以内、差に応じた重み）のうち、最良の仮説と同じステッカーがあると見る割合
  seenAt: number[]; // そこにいまあるステッカーを最後に直接見た時刻（-1 = 見ていない）
  movedAt: number[]; // そのステッカーを最後に動かした手の回し終わり（-1 = 始めから動いていない）
}

export const CERTAIN = 0.9;
const BELIEF_MARGIN = 3; // これより高い仮説は数えない（1 手 1.0・1 枚の矛盾 1.5）
const BELIEF_TEMP = 1; // 重み exp(-(コスト差) / これ)

// 未確定・推定のマス（キューブ固定の facelet）
export function doubtfulCells(c: CellBelief): number[] {
  const out: number[] = [];
  for (let f = 0; f < 54; f++) if (c.certainty[f] < CERTAIN || c.seenAt[f] < c.movedAt[f]) out.push(f);
  return out;
}

// 姿勢 orient で見たときの、未確定・推定のマス（カメラフレームの slot * 9 + cell）。認識で先に読み直す（再認識）
export function focusCells(c: CellBelief, orient: number): number[] {
  const out: number[] = [];
  for (let slot = 0; slot < 5; slot++)
    for (let cell = 0; cell < 9; cell++) {
      const f = VIEW[(orient * 6 + slot) * 9 + cell];
      if (c.certainty[f] < CERTAIN || c.seenAt[f] < c.movedAt[f]) out.push(slot * 9 + cell);
    }
  return out;
}

// ステッカー（揃った状態での facelet 番号）ごとの、最後に動かした手の回し終わりの時刻（-1 = 動いていない）。
// state は moves をすべて回した後の状態。いまの状態から手を逆にたどる（新しい手から。最初に当たったものが最後に動かした手）
export function lastMoved(state: CubeState, moves: DecodedMove[]): Float64Array {
  const moved = new Float64Array(54).fill(-1);
  const done = new Uint8Array(54);
  let s = state;
  for (let i = moves.length - 1; i >= 0; i--) {
    const m = moves[i];
    for (const f of LAYER[moveFace(m.move)]) {
      const id = stickerIdAt(s, f);
      if (id >= 0 && !done[id]) {
        done[id] = 1;
        moved[id] = m.t;
      }
    }
    s = applyMove(s, inverseMove(m.move));
  }
  return moved;
}

// 層 face にある facelet（その手で動くもの。回す面そのものも含む）
const LAYER: number[][] = NORMAL.map((n) =>
  Array.from({ length: 54 }, (_, f) => f).filter((f) => {
    const p = faceletGeometry(f).pos;
    return p[0] * n[0] + p[1] * n[1] + p[2] * n[2] === 1;
  }),
);

// 回転途中の形のつながり → 手の手がかり。軸の正の側の層を負の側に対して回した角度（slot が負の側の面なら符号を逆に）。
// 45° に届かない（回しかけて戻した・回転の一部しか見えていない）なら使わない。量（90° 単位）は、回し始めの近くから見えていて
// フレームの間の角度の変化が小さい（90° ごとのつなぎ方を誤らない）ときだけ。そうでなければどの軸かだけ
const TURN_GAP_MS = 120; // これだけ見えなければ回転のつながりは終わり
export function turnHint(s: TurnSnapshot): TurnHint | null {
  if (s.frames < 2) return null;
  const phi = s.slot < 3 ? s.total : -s.total;
  if (Math.abs(phi) < Math.PI / 4) return null;
  const reliable = s.frames >= 3 && s.maxStep < (30 * Math.PI) / 180 && Math.abs(s.first) < (25 * Math.PI) / 180;
  const q = Math.round(phi / (Math.PI / 2));
  // 回し終わりが 90° の倍数から大きくずれている（まだ回している途中で見えなくなった）なら量は使わない
  const settled = Math.abs(phi - (q * Math.PI) / 2) < (25 * Math.PI) / 180;
  return { slot: s.slot, quarters: reliable && settled ? ((q % 4) + 4) % 4 : null };
}

export class TrackerEngine {
  readonly colors: ColorModel;
  readonly observer: FaceObserver;
  readonly decoder: MoveDecoder;
  readonly frames: LoggedFrame[] = [];
  readonly observationLog: Observation[] = [];
  // ステッカー（揃った状態での facelet 番号）ごとの、最後に直接見た時刻
  readonly lastSeen = new Float64Array(54).fill(-1);
  logMs: number;
  private keepObservations: boolean;

  constructor(start: CubeState, refs: Lab[], options: Partial<EngineOptions> = {}, orients?: number[]) {
    this.colors = new ColorModel(refs, options.colors);
    this.observer = new FaceObserver(this.colors, options.observer);
    this.decoder = new MoveDecoder(start, options.decoder, orients);
    this.logMs = options.logMs ?? 12000;
    this.keepObservations = !!options.keepObservations;
    this.maxObservations = options.maxObservations ?? Infinity;
    this.repeatMs = options.repeatMs ?? 250;
    this.snapToView = !!options.snapToView;
    this.recoverOpts = options.recover ? (options.recover === true ? {} : options.recover) : null;
    if (options.personal?.length && this.decoder.prior) this.decoder.prior = movePrior(options.personal);
    if (options.orient) this.orient = new OrientTracker(options.orient === true ? {} : options.orient);
    if (options.pieces !== undefined) {
      this.watchCenters = true;
      warmLiveTables();
    }
    if (options.pieces) this.setPieces(options.pieces);
  }
  // ソルブ中のライブの状態の推定（EngineOptions.pieces。null = 今までの追跡）
  live: LiveState | null = null;
  private liveKey = "";
  private liveEmitT = -Infinity;
  readonly liveMs = { push: 0, snap: 0, pushOver: 0, snapOver: 0 }; // 調査用: 推定と TrackUpdate づくりの時間
  private liveOpts: Partial<LiveStateOptions> | null = null;
  private liveView: TrackUpdate["view"] = null;
  private liveStart: CubeState | null = null; // 推定の手順の始まり（base がないとき）の状態
  private lastFrameT = 0;
  private lastReading: FrameReading | null = null;

  // 置き方の決まった面で最後に見たセンターの向き（面ごと。推定に切り替えたときの初めの向き）。watchCenters: pieces を渡したとき（false でも）だけ見る
  private readonly centerSeen: ({ phi: number; t: number } | null)[] = new Array(6).fill(null);
  watchCenters = false;

  private setPieces(p: boolean | Partial<LiveStateOptions>): void {
    if (p) {
      this.liveOpts = p === true ? {} : p;
      if (this.live) return;
      const best = this.decoder.best();
      const moves = this.decoder.bestMoves();
      const phi = this.centerSeen.map((c, f) => {
        if (!c) return -1;
        let v = c.phi;
        for (const m of moves) if (m.t > c.t && ((m.move / 3) | 0) === f) v = (v + (m.move % 3) + 1) & 3;
        return v;
      });
      let start: CubeState = new Uint8Array(best.state);
      for (let i = moves.length - 1; i >= 0; i--) start = applyMove(start, inverseMove(moves[i].move));
      this.liveStart = best.origin ? null : start;
      this.live = new LiveState(best.state, best.orient, this.lastFrameT, moves, best.origin ?? null, this.liveOpts, phi);
      this.liveView = this.view;
      return;
    }
    if (!this.live) return;
    // ふだんの追跡に戻す: 推定の状態と手順をそのままデコーダへ
    const live = this.live;
    const b = live.best();
    const state = live.display(b);
    const known = live.known(b);
    this.decoder.adopt(state, live.orient, live.moves(b), known ? (b.base ?? null) : { n: (b.base?.n ?? 0) + 1000, at: live.moves(b).length, state: Array.from(state), t: this.lastFrameT });
    this.observer.reset();
    this.live = null;
    this.liveOpts = null;
    this.view = null;
    this.snapStreak = 0;
  }
  // キューブ全体の向き（orient）: 追う部品と、前の観測のフレームの時刻
  readonly orient: OrientTracker | null = null;
  private orientT = -Infinity;
  lastOrient: OrientHint | null = null; // 最後の観測に付けたもの（調査用）
  private maxObservations: number;
  private repeatMs: number;
  private snapToView: boolean;
  private snapStreak = 0;
  // 見失ったところからの復帰: 錨 = 最後に観測とよく合っていた仮説。trouble = 合わなくなった時刻（合っている間は null）
  private recoverOpts: Partial<RecoverOptions> | null = null;
  private anchor: { hyp: Hypothesis; t: number } | null = null;
  private troubleT: number | null = null;
  private lastTry = -Infinity;
  recoveries = 0; // 復帰した回数（調査用）
  recoverMs = 0; // 復帰の探索にかかった時間の合計（調査用）
  recoverMax = 0; // 1 回の探索にかかった時間の最大（調査用）
  recoverTries = 0; // 探索した回数（調査用）
  private snaps = 0; // 作り変えた仮説を足した回数
  // 一番合う仮説が作り変えで足した仮説（の続き）なら、その作り変え
  get base(): TrackUpdate["base"] {
    return this.decoder.best()?.origin ?? null;
  }
  view: TrackUpdate["view"] = null;
  private lastObsT = -Infinity;
  private repeats = 0;

  setOptions(options: Partial<EngineOptions>): void {
    if (options.decoder) this.decoder.setOptions(options.decoder);
    if (options.observer) Object.assign(this.observer.options, options.observer);
    if (options.colors) Object.assign(this.colors.options, options.colors);
    if (options.logMs !== undefined) this.logMs = options.logMs;
    if (options.snapToView !== undefined) {
      this.snapToView = options.snapToView;
      if (!this.snapToView) {
        this.view = null;
        this.snapStreak = 0;
      }
    }
    if (options.personal && this.decoder.options.priorWeight > 0) this.decoder.prior = movePrior(options.personal);
    if (options.pieces !== undefined) {
      if (!this.watchCenters) warmLiveTables();
      this.watchCenters = true;
      this.setPieces(options.pieces);
    }
  }

  reset(state: CubeState, orients?: number[]): void {
    const pieces = this.liveOpts;
    this.live = null;
    this.decoder.reset(state, orients);
    this.view = null;
    this.snapStreak = 0;
    this.observer.reset();
    this.orient?.reset();
    this.orientT = -Infinity;
    this.turnCur = null;
    this.turnHints = [];
    this.lastSeen.fill(-1);
    this.timingCache.clear();
    if (pieces) this.setPieces(pieces);
  }

  push(frame: FrameReading, sight?: SightFrame): TrackUpdate | null {
    this.orient?.push(frame, sight);
    this.frames.push({ t: frame.t, faces: frame.faces.map((f) => ({ slot: f.slot, labs: f.labs, valid: f.valid, spread: f.spread, masked: f.masked, shift: f.shift, ids: f.ids })) });
    while (this.frames.length && frame.t - this.frames[0].t > this.logMs) this.frames.shift();
    this.lastFrameT = frame.t;
    if (!this.live && this.watchCenters && sight?.faces.length) {
      // 推定に切り替えたときのセンターの向き: 置き方の決まった面で最後に見たセンターの向きと、その後の追跡の手から
      for (const c of liveFrame(sight).centers) this.centerSeen[c.f] = { phi: c.phi, t: frame.t };
    }
    if (this.live) {
      // ソルブ中のライブの状態の推定: 読み（面の置き方はセンターの ID と面の接し方から。スロットには頼らない）をそのまま渡す
      if (!sight?.faces.length) return null;
      this.lastReading = frame;
      const a = performance.now();
      if (!this.live.pushSight(sight)) return null;
      const b = performance.now();
      // 手順・状態が変わらなければ、100ms ごとにだけ出す（TrackUpdate づくり（手の時刻）がフレームの時間の大半だった）
      const lb = this.live.best();
      const key = `${lb.tail?.len ?? 0}:${lb.tail?.move ?? -1}:${lb.tail?.t ?? 0}:${lb.base?.n ?? 0}:${this.live.known(lb) ? 1 : 0}:${this.live.options.agreeWait ? this.live.agreed() : 0}`;
      if (key === this.liveKey && frame.t - this.liveEmitT < LIVE_EMIT_MS) return null;
      this.liveKey = key;
      this.liveEmitT = frame.t;
      const u = this.liveSnapshot(frame);
      const c = performance.now();
      this.liveMs.push += b - a;
      this.liveMs.snap += c - b;
      if (b - a > 3) this.liveMs.pushOver++;
      if (c - b > 3) this.liveMs.snapOver++;
      return u;
    }
    this.collectTurn(frame);
    const repeat = this.repeatMs > 0 && this.repeats < MAX_REPEATS && this.decoder.lastObservationCost >= REPEAT_COST && frame.t - this.lastObsT >= this.repeatMs;
    const obs = this.observer.push(frame, repeat);
    if (!obs) return null;
    // 出し直し（読みが前と同じ）かどうか: 観測器が新しい読みとして出したら数え直す
    this.repeats = repeat && this.observer.lastWasRepeat ? this.repeats + 1 : 0;
    this.lastObsT = frame.t;
    // 前の観測からの間に回転途中の形で見えた層の回転を、この観測に付ける（見え方が落ち着いた = 回し終わった）
    this.finishTurn();
    if (this.turnHints.length) obs.turns = this.turnHints;
    this.turnHints = [];
    if (this.orient) {
      // 前の観測のフレームから同じ所にいるステッカー（最初の観測にはない）
      obs.orient = Number.isFinite(this.orientT) ? this.orient.stillSince(this.orientT) : null;
      this.lastOrient = obs.orient;
      this.orientT = frame.t;
    }
    if (this.keepObservations) {
      this.observationLog.push(obs);
      if (this.observationLog.length > this.maxObservations) this.observationLog.splice(0, this.observationLog.length - this.maxObservations);
    }
    return this.observe(obs, frame);
  }

  // 回転途中の形で見えている層の回転（フレームごとのつながり）をためる。つながりが変わった・途切れたら 1 つの回転としてまとめる
  private turnCur: (TurnSnapshot & { lastT: number }) | null = null;
  private turnHints: TurnHint[] = [];
  private collectTurn(frame: FrameReading): void {
    const s = frame.turn;
    if (s) {
      if (this.turnCur && (this.turnCur.slot !== s.slot || this.turnCur.start !== s.start)) this.finishTurn();
      this.turnCur = { ...s, lastT: frame.t };
    } else if (this.turnCur && frame.t - this.turnCur.lastT > TURN_GAP_MS) this.finishTurn();
  }
  private finishTurn(): void {
    const h = this.turnCur && turnHint(this.turnCur);
    if (h) this.turnHints.push(h);
    this.turnCur = null;
  }

  observe(obs: Observation, frame?: FrameReading): TrackUpdate {
    this.decoder.observe(obs);
    const recovered = this.recoverOpts ? this.recover(obs) : false;
    if (this.snapToView && !recovered) {
      this.snap(obs);
      this.preferSolved(obs);
    }
    const best = this.decoder.best();
    this.markSeen(obs);
    // デコーダが確信していて、観測とよく合っているときだけ代表色を寄せる
    if (frame && this.decoder.status === "tracking" && best.obsCost < 0.5 && this.decoder.margin() > 1.5) {
      for (const f of frame.faces) {
        f.labs.forEach((lab, cell) => {
          if (!f.valid[cell]) return;
          this.colors.adapt(lab, best.state[VIEW[(best.orient * 6 + f.slot) * 9 + cell]]);
        });
      }
    }
    return this.snapshot(obs);
  }

  // 見失ったところからの復帰。錨は、観測とよく合っていて、錨の仮説と同じ流れ（間に作り変えがない）の仮説で更新する。合わなくなったら
  // （SNAP_COST 以上）、それから RECOVER_MS の間、読めたステッカーの多い観測ごとに、錨から 8 手までで全部合う手順を探す
  private recover(obs: Observation): boolean {
    const best = this.decoder.best();
    const good = best.obsCost < ANCHOR_COST && this.decoder.status === "tracking";
    const sameFlow = !this.anchor || (best.origin ?? null) === (this.anchor.hyp.origin ?? null);
    if (good && (this.troubleT === null || sameFlow)) {
      this.anchor = this.trusted(best) ? { hyp: best, t: obs.t } : null;
      this.troubleT = null;
      return false;
    }
    if (this.troubleT === null) {
      if (best.obsCost < SNAP_COST) return false;
      this.troubleT = obs.t;
    }
    // 錨が古すぎる（8 手より多く回している）: あきらめて、いまの仮説を錨にする
    if (!this.anchor || obs.t - this.anchor.t > RECOVER_MS) {
      if (good) {
        this.anchor = this.trusted(best) ? { hyp: best, t: obs.t } : null;
        this.troubleT = null;
      }
      return false;
    }
    if (obs.t - this.lastTry < RECOVER_GAP_MS) return false;
    const a = performance.now();
    const found = recoverFrom(this.anchor.hyp.state, obs, orientsOf(obs, [best.orient, this.anchor.hyp.orient]), this.recoverOpts!);
    const spent = performance.now() - a;
    this.recoverMs += spent;
    this.recoverMax = Math.max(this.recoverMax, spent);
    if (found?.length !== 0) this.recoverTries++;
    if (!found) {
      this.lastTry = obs.t;
      return false;
    }
    if (!found.length) return false; // 読めたステッカーが足りない: 次の観測で試す
    this.lastTry = obs.t;
    this.recoveries++;
    this.decoder.injectPaths(this.anchor.hyp, found, this.anchor.t, obs.t, 0, -RECOVER_BONUS, this.anchor.hyp.origin);
    this.view = null;
    this.snapStreak = 0;
    return true;
  }

  // 錨にしてよい仮説: 作り変えで足した仮説（の続き）は、見えていない面が推測なので、作り変えた後にどのステッカーも一度は見直してから
  // （実物のソルブで、推測のままの状態を錨にして、そこから間違った手順に復帰していた）
  private trusted(h: Hypothesis): boolean {
    if (!h.origin) return true;
    for (let s = 0; s < 54; s++) if (s % 9 !== 4 && this.lastSeen[s] < h.origin.t) return false;
    return true;
  }

  // 作り変え（snapToView）: 一番合う仮説でもはっきり合わない見え方が続いたら、見えている色に合う状態を作る。
  //   - 3D の表示は、その場でその状態にする（view。追跡はそのまま探し続ける）
  //   - 矛盾が続いた・見失ったら、その状態を追跡の仮説に足す（base: 一番合う仮説がその子孫のとき。見失ったときは置き換える）
  private snap(obs: Observation): void {
    const best = this.decoder.best();
    this.snapStreak = best.obsCost >= SNAP_COST ? this.snapStreak + 1 : 0;
    if (this.snapStreak < 2 && best.obsCost < SNAP_NOW) {
      if (!this.snapStreak) this.view = null;
      return;
    }
    const r = snapToObservation(best.state, best.orient, obs);
    if (!r || r.cost > best.obsCost - SNAP_GAIN) return;
    if (this.decoder.status === "lost" || this.snapStreak >= OVERWRITE_STREAK) {
      const at = this.decoder.bestMoves().length;
      this.snaps++;
      this.decoder.inject(r.state, r.orient, r.cost, { n: this.snaps, at, state: Array.from(r.state), t: obs.t }, INJECT_COST);
      this.view = null;
      this.snapStreak = 0;
      return;
    }
    // 表示だけ: 前と同じ状態なら作り直さない（3D がそのたびにソルバーで作り直さないように）
    const same = this.view && this.view.state.every((c, i) => c === r.state[i]) && this.view.orient === r.orient;
    if (!same) this.view = { n: (this.view?.n ?? 0) + 1, state: Array.from(r.state), orient: r.orient, t: obs.t };
  }

  // 作り変えた仮説（見えていない面は推測）が一番のまま、見えている 2 面以上がどれも揃っていて揃った状態でも説明できるなら、
  // 揃った状態の仮説も足す（速く回して見失った後に揃えると、見えている面は揃っているのに見えていない面が推測のままで、3D が
  // 揃わなかった: 実物の T-perm 2 回の速いもの）
  private preferSolved(obs: Observation): void {
    const best = this.decoder.best();
    if (!best.origin || isSolved(best.state)) return;
    if (obs.faces.filter((f) => f.labels.filter((l) => l >= 0).length >= SOLVED_FACE_CELLS).length < 2) return;
    const solved = solvedState();
    let o = -1;
    let cost = Infinity;
    for (let k = 0; k < 24; k++) {
      const c = observationCost(solved, k, obs);
      if (c < cost) {
        cost = c;
        o = k;
      }
    }
    if (cost > best.obsCost + 0.05 || cost > 0.5) return;
    this.snaps++;
    this.decoder.inject(solved, o, cost, { n: this.snaps, at: this.decoder.bestMoves().length, state: Array.from(solved), t: obs.t }, -0.1);
  }

  // 見えている面がすべて1色か（完成の見た目）。高速回転で追跡を見失っていても、タイマーを止められるように。
  // 2面以上が（手で隠れていないセルの）6枚以上読めて、どの面にも違う色が混ざっていないこと
  // 各面の各セルの最近傍の色（読めない・手で隠れたセルは -1）
  labelsOf(frame: FrameReading): number[][] {
    return frame.faces.map((f) => f.labs.map((lab, cell) => (f.valid[cell] && !f.masked?.[cell] ? this.colors.classify(lab).label : -1)));
  }

  looksSolved(frame: FrameReading, labels = this.labelsOf(frame)): boolean {
    let uniform = 0;
    for (let i = 0; i < frame.faces.length; i++) {
      let known = 0;
      let label = -1;
      for (let cell = 0; cell < 9; cell++) {
        const c = labels[i][cell];
        if (c < 0) continue;
        if (label >= 0 && c !== label) return false;
        label = c;
        known++;
      }
      if (known >= 6) uniform++;
    }
    return uniform >= 2;
  }

  // このフレームの見え方に最も合う姿勢（追跡の最良の状態と照合。中心の色でほぼ決まる）。
  // 3D 表示を毎フレームのキューブの向きに合わせるのに使う（観測を待たずに、持ち替えにすぐ追従する）
  // continuity: 姿勢 o を選んだときの、直前の 3D の向きからの飛びの罰（0〜1 未満）。見え方で区別できないとき
  // （1 面だけ・センターが隠れて 1 色）に、90° ずつ違う向きのどれかへ跳ねないように直前の向きに近いものを選ぶ
  frameOrient(frame: FrameReading, labels = this.labelsOf(frame), continuity?: (o: number) => number): number {
    // 3D に出している状態（表示だけの作り変えの間はそれ）と照らす
    const best = this.live ? { state: this.live.display(), orient: this.live.orient } : this.view ? { state: this.view.state, orient: this.view.orient } : this.decoder.best();
    let bestO = best.orient;
    let bestCost = Infinity;
    for (let o = 0; o < 24; o++) {
      let cost = continuity ? continuity(o) : o === best.orient ? -0.5 : 0;
      for (let i = 0; i < frame.faces.length; i++) {
        const base = (o * 6 + frame.faces[i].slot) * 9;
        for (let cell = 0; cell < 9; cell++) {
          const c = labels[i][cell];
          if (c >= 0 && c !== best.state[VIEW[base + cell]]) cost += cell === 4 ? 3 : 1;
        }
      }
      if (cost < bestCost) {
        bestCost = cost;
        bestO = o;
      }
    }
    return bestO;
  }

  // 観測で読めたマスのうち、最良の仮説と合うもの: そこにあるステッカーを「見た」
  private markSeen(obs: Observation): void {
    const best = this.decoder.best();
    for (const f of obs.faces) {
      for (let cell = 0; cell < 9; cell++) {
        const label = f.labels[cell];
        if (label < 0) continue;
        const fl = VIEW[(best.orient * 6 + f.slot) * 9 + cell];
        if (best.state[fl] !== label) continue;
        const id = stickerIdAt(best.state, fl);
        if (id < 0 || (f.ids && f.ids[cell] >= 0 && f.ids[cell] !== id)) continue;
        this.lastSeen[id] = Math.max(this.lastSeen[id], obs.t);
      }
    }
  }

  // マスごとの確からしさ（CellBelief）
  cellBelief(): CellBelief {
    const beam = this.decoder.hypotheses();
    const best = beam[0];
    const bestIds = Array.from({ length: 54 }, (_, f) => stickerIdAt(best.state, f));
    const agree = new Float64Array(54);
    let total = 0;
    for (const h of beam) {
      if (h.cost > best.cost + BELIEF_MARGIN) continue;
      const w = Math.exp(-(h.cost - best.cost) / BELIEF_TEMP);
      total += w;
      for (let f = 0; f < 54; f++) if (h === best || stickerIdAt(h.state, f) === bestIds[f]) agree[f] += w;
    }
    const moved = lastMoved(best.state, this.decoder.bestMoves());
    return {
      certainty: Array.from(agree, (a) => (total ? a / total : 1)),
      seenAt: bestIds.map((id) => (id >= 0 ? this.lastSeen[id] : -1)),
      movedAt: bestIds.map((id) => (id >= 0 ? moved[id] : -1)),
    };
  }

  // 手の開始・終了時刻（フレームの記録から）
  // 手の時刻は、その手の観測から TIMING_FINAL_MS たてば変わらない（moveTiming が見るのは観測の 550ms 後までのフレーム）ので覚えておく。
  // snapshot は観測のたびに全部の手の時刻を出すので、手が増えるほど毎回の計算が増えていた（実物のソルブ 79 手のライブを全フレームで
  // 追跡 1.0 → 0.7ms/フレーム）
  private timingCache = new Map<string, MoveTiming>();
  timing(m: DecodedMove): MoveTiming | null {
    if (!this.frames.length || (m.t0 ?? m.t) < this.frames[0].t) return null;
    const settled = this.frames[this.frames.length - 1].t - m.t > TIMING_FINAL_MS;
    const key = settled ? `${m.move}:${m.t0}:${m.t}:${m.orient}:${m.inferred ? 1 : 0}` : "";
    const hit = settled ? this.timingCache.get(key) : undefined;
    if (hit) return hit;
    const tm = moveTiming(this.frames, m, { ...DEFAULT_TIMING, refs: this.colors.refs });
    if (settled) {
      if (this.timingCache.size > 4000) this.timingCache.clear();
      this.timingCache.set(key, tm);
    }
    return tm;
  }

  // ライブの状態の推定の TrackUpdate: 3D に出すのは一番よい仮説。決まらないピースのある間は、決まったピースだけを動かした状態を view にする
  // （手を回して見せない）。決まったピースの位置が手順から決まる位置と違ったら（見失って読みの位置にした後）、そこで手順を切る（base）
  private liveSnapshot(frame?: FrameReading): TrackUpdate {
    const live = this.live!;
    const b = live.best();
    const moves = live.moves(b);
    const known = live.known(b);
    const shown = live.display(b);
    if (known) {
      // 手順から決まる状態と違えば、そこで手順を切る
      const from = b.base ? Uint8Array.from(b.base.state) : this.liveStart;
      if (from) {
        let st: CubeState = from;
        for (let i = b.base?.at ?? 0; i < moves.length; i++) st = applyMove(st, moves[i].move);
        if (!st.every((c, i) => c === shown[i])) {
          b.base = { n: (b.base?.n ?? 0) + 1, at: moves.length, state: Array.from(shown), t: frame?.t ?? this.lastFrameT };
        }
      }
      this.liveView = null;
    } else if (!this.liveView || !this.liveView.state.every((c, i) => c === shown[i])) this.liveView = { n: (this.liveView?.n ?? 0) + 1, state: Array.from(shown), orient: live.orient, t: frame?.t ?? this.lastFrameT };
    // マスごとの確からしさ: 決まらないピースのマスは 0（ライブは読み直しをしないので、ほかは使わない）
    const certainty = new Array<number>(54).fill(1);
    if (!known) {
      const sure = live.stateOf(b);
      for (let f = 0; f < 54; f++) if (sure[f] !== shown[f]) certainty[f] = 0;
    }
    const fr = frame ?? this.lastReading;
    return {
      status: !known ? "lost" : b.last >= live.options.deepAbove ? "uncertain" : "tracking",
      moves,
      timings: moves.map((m) => this.timing(m)),
      confirmed: live.agreed(),
      ...(live.options.agreeWait ? { agreed: known ? live.agreed() : 0 } : {}),
      state: Array.from(shown),
      orient: live.orient,
      solved: live.solved(),
      margin: live.hyps.length > 1 ? live.hyps[1].cost - b.cost : Infinity,
      obsCost: b.last,
      observations: live.stats.steps,
      recoveries: live.stats.recovered,
      refs: this.colors.refs.map((r) => [...r] as Lab),
      observation: { t: fr?.t ?? 0, faces: (fr?.faces ?? []).map((f) => ({ slot: f.slot, labels: Array.from({ length: 9 }, (_, c) => (f.ids && f.ids[c] >= 0 && f.valid[c] ? Math.floor(f.ids[c] / 9) : -1)) })) },
      cells: { certainty, seenAt: new Array(54).fill(-1), movedAt: new Array(54).fill(-1) },
      base: b.base,
      view: this.liveView,
    };
  }

  snapshot(obs?: Observation): TrackUpdate {
    if (this.live) return this.liveSnapshot();
    const best = this.decoder.best();
    const moves = this.decoder.bestMoves();
    return {
      status: this.decoder.status,
      moves,
      timings: moves.map((m) => this.timing(m)),
      confirmed: this.decoder.confirmedCount(),
      state: Array.from(best.state),
      orient: best.orient,
      solved: isSolved(best.state),
      margin: this.decoder.margin(),
      obsCost: this.decoder.lastObservationCost,
      observations: this.decoder.observations,
      recoveries: this.decoder.recoveries,
      refs: this.colors.refs.map((r) => [...r] as Lab),
      observation: { t: obs?.t ?? 0, faces: (obs?.faces ?? []).map((f) => ({ slot: f.slot, labels: Array.from(f.labels) })) },
      cells: this.cellBelief(),
      base: this.base,
      view: this.view,
    };
  }
}

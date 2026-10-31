// 追跡エンジン: フレームの読み取り → 安定観測 → デコーダ → 結果。カメラも DOM も知らない。
// Worker の中でもテストの中でも同じコードが動く。
import { type CubeState, NORMAL, applyMove, faceletGeometry, inverseMove, isSolved, moveFace, VIEW } from "../cube/model";
import { stickerIdAt } from "../cube/stickers";
import type { Lab } from "../vision/color";
import { ColorModel, type ColorModelOptions } from "./colorModel";
import { type DecoderOptions, MoveDecoder } from "./decoder";
import { movePrior } from "./prior";
import { FaceObserver, type FrameReading, type ObserverOptions } from "./observer";
import { DEFAULT_TIMING, type LoggedFrame, type MoveTiming, moveTiming } from "./timing";
import type { DecodedMove, Observation, TrackStatus, TurnHint, TurnSnapshot } from "./types";

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
}

const REPEAT_COST = 0.8;
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
    if (options.personal?.length && this.decoder.prior) this.decoder.prior = movePrior(options.personal);
  }
  private maxObservations: number;
  private repeatMs: number;
  private lastObsT = -Infinity;
  private repeats = 0;

  setOptions(options: Partial<EngineOptions>): void {
    if (options.decoder) this.decoder.setOptions(options.decoder);
    if (options.observer) Object.assign(this.observer.options, options.observer);
    if (options.colors) Object.assign(this.colors.options, options.colors);
    if (options.logMs !== undefined) this.logMs = options.logMs;
    if (options.personal && this.decoder.options.priorWeight > 0) this.decoder.prior = movePrior(options.personal);
  }

  reset(state: CubeState, orients?: number[]): void {
    this.decoder.reset(state, orients);
    this.observer.reset();
    this.turnCur = null;
    this.turnHints = [];
    this.lastSeen.fill(-1);
  }

  // 精密解析（別の Worker）が時刻 t までを解き直した結果に乗り換え、t より後の観測をもう一度通す。
  // keep: 解析を始めたときにすでにあった手の数（その手は残し、後ろに解析の手順をつなぐ）
  rebase(state: CubeState, orient: number, moves: DecodedMove[], t: number, keep: number): TrackUpdate {
    const prefix = [...this.decoder.bestMoves().slice(0, keep), ...moves];
    this.decoder.rebase(state, orient, prefix);
    let first = this.observationLog.findIndex((o) => o.t > t);
    if (first < 0) first = this.observationLog.length;
    this.observationLog.splice(0, first);
    let last: Observation | undefined;
    for (const o of this.observationLog) {
      this.decoder.observe(o);
      last = o;
    }
    return this.snapshot(last);
  }

  push(frame: FrameReading): TrackUpdate | null {
    this.frames.push({ t: frame.t, faces: frame.faces.map((f) => ({ slot: f.slot, labs: f.labs, valid: f.valid, spread: f.spread, masked: f.masked, shift: f.shift, ids: f.ids })) });
    while (this.frames.length && frame.t - this.frames[0].t > this.logMs) this.frames.shift();
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
    const best = this.decoder.best();
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
  timing(m: DecodedMove): MoveTiming | null {
    if (!this.frames.length || (m.t0 ?? m.t) < this.frames[0].t) return null;
    return moveTiming(this.frames, m, { ...DEFAULT_TIMING, refs: this.colors.refs });
  }

  snapshot(obs?: Observation): TrackUpdate {
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
    };
  }
}

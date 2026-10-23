// スマートキューブ風のタイマー: スクランブル誘導 → インスペクション → 最初の1手で開始 → 完成で停止。
//
// 時間は「最初の手の回し始め」から「最後の手の回し終わり」まで（フレームの記録から、誤差はフレーム間隔の半分程度）。
// 止めた瞬間はリアルタイムの追跡からの速報値を出し、計測中に録画しておいた全フレームを別の Worker で
// 1枚ずつ解析し直して、数秒〜数十秒後に時間と手順を確定する（リアルタイムでは処理が追いつかないフレームも使う）。
import { cfopSplits } from "../cube/analysis";
import { type CubeState, MOVE_NAMES, applyMoves, isSolved, relativeMove, rotateOrientation, solvedState, statesEqual } from "../cube/model";
import { randomScramble, solveBetween } from "../cube/solver";
import type { TrackUpdate } from "../track/engine";
import { mergeQuickRepeats } from "../track/merge";
import type { Lab } from "../vision/color";
import type { RefineResult } from "../vision/refine";
import { controller } from "./controller";
import { settingsStore } from "./settings";
import { type Solve, loadSolves, saveSolves } from "./storage";
import { createStore } from "./store";

export type TimerPhase = "idle" | "preparing" | "scrambling" | "inspection" | "solving" | "done";

export interface TimerState {
  phase: TimerPhase;
  scramble: number[];
  guide: number[]; // 現在の状態からスクランブル完了までの手順
  guideDone: number; // guide のうち済んだ手数
  recomputing: boolean;
  inspectionStart: number;
  startT: number;
  startIndex: number;
  liveMoves: number;
  result: Solve | null;
  solves: Solve[];
  message: string | null;
  analysisProgress: number; // 精密解析の進み具合（0..1）
}

export const timerStore = createStore<TimerState>({
  phase: "idle",
  scramble: [],
  guide: [],
  guideDone: 0,
  recomputing: false,
  inspectionStart: 0,
  startT: 0,
  startIndex: 0,
  liveMoves: 0,
  result: null,
  solves: loadSolves(),
  message: null,
  analysisProgress: 0,
});

let target: CubeState | null = null;
let guideStates: CubeState[] = [];
let readyMoves = 0;
let recomputeTimer = 0;
let warned8 = false;
let warned12 = false;
let recording = false;
let lookRun = 0;
let lookStartT = 0;

const POSTROLL_MS = 1200; // 止めた後も録画を続ける時間（最後の手の回し終わりを確かめる）
const PREROLL_MS = 1500; // 最初の手の前から解析する時間

// 時刻つきの手（キューブ固定の手、そのときの姿勢、回し始め・回し終わり）
interface TimedMove {
  move: number;
  orient: number;
  start: number;
  end: number;
  inferred?: boolean;
}

function liveTimed(u: TrackUpdate, from: number, to = u.moves.length): TimedMove[] {
  const moves = u.moves.slice(from, to).map((m, i) => {
    const tm = u.timings?.[from + i];
    return { ...m, start: tm?.start ?? m.t0 ?? m.t, end: tm?.end ?? m.t };
  });
  return mergeQuickRepeats(moves).map((m) => ({ move: m.move, orient: m.orient, start: m.start, end: Math.max(m.start, m.end), ...(m.inferred ? { inferred: true } : {}) }));
}

const viewOrient = (o: number) => (settingsStore.get().viewpoint === "user" && !controller.store.get().demo ? rotateOrientation(o, "y", 2) : o);

function setGuide(from: CubeState, moves: number[]): void {
  guideStates = [from];
  for (const m of moves) guideStates.push(applyMoves(guideStates[guideStates.length - 1], [m]));
  timerStore.set({ guide: moves, guideDone: 0, recomputing: false });
}

export async function newScramble(): Promise<void> {
  const track = controller.store.get().track;
  const cube = controller.store.get().cube;
  if (!cube) {
    timerStore.set({ message: "先にキューブをスキャンしてください。" });
    return;
  }
  timerStore.set({ phase: "preparing", message: null, result: null });
  const scramble = await randomScramble();
  target = applyMoves(solvedState(), scramble);
  const current = Uint8Array.from(track?.state ?? cube.state);
  timerStore.set({ phase: "scrambling", scramble });
  if (isSolved(current)) setGuide(current, scramble);
  else {
    timerStore.set({ recomputing: true });
    setGuide(current, await solveBetween(current, target));
  }
}

export function cancelTimer(): void {
  target = null;
  if (recording) controller.recorder.clear();
  recording = false;
  timerStore.set({ phase: "idle", guide: [], scramble: [], message: null });
}

function recompute(state: CubeState): void {
  clearTimeout(recomputeTimer);
  timerStore.set({ recomputing: true });
  recomputeTimer = window.setTimeout(async () => {
    if (!target || timerStore.get().phase !== "scrambling") return;
    const latest = Uint8Array.from(controller.store.get().track?.state ?? state);
    if (statesEqual(latest, target)) return;
    setGuide(latest, await solveBetween(latest, target));
  }, 350);
}

function onTrack(u: TrackUpdate): void {
  const s = timerStore.get();
  const state = Uint8Array.from(u.state);
  if (s.phase === "scrambling" && target) {
    if (statesEqual(state, target)) {
      readyMoves = u.moves.length;
      warned8 = warned12 = false;
      controller.beep(660, 0.15);
      timerStore.set({ phase: "inspection", inspectionStart: performance.now(), guideDone: s.guide.length, recomputing: false });
      recording = false;
      controller.startRecording().then((ok) => (recording = ok && timerStore.get().phase !== "idle"));
      return;
    }
    const k = guideStates.findIndex((g, i) => i >= s.guideDone && statesEqual(g, state));
    if (k >= 0) timerStore.set({ guideDone: k });
    else recompute(state);
    return;
  }
  if (s.phase === "inspection") {
    if (u.moves.length > readyMoves && !(target && statesEqual(state, target))) {
      const first = u.moves[readyMoves];
      // 回し始め（フレームの記録から）。分からなければ観測の時刻
      const startT = u.timings?.[readyMoves]?.start ?? first.t0 ?? first.t;
      timerStore.set({ phase: "solving", startT, startIndex: readyMoves, liveMoves: u.moves.length - readyMoves });
      controller.recorder.keepMs = 150000;
      lookRun = 0;
      controller.beep(990, 0.08);
    }
    return;
  }
  if (s.phase === "solving") {
    timerStore.set({ liveMoves: Math.max(0, u.moves.length - s.startIndex) });
    if (u.solved) finish(u, "tracked");
  }
}

// 追跡を見失っていても、見えている面がすべて1色のまま数フレーム続いたら止める
function onFrame(m: { t: number; looksSolved?: boolean }): void {
  if (timerStore.get().phase !== "solving" || m.looksSolved === undefined) {
    lookRun = 0;
    return;
  }
  if (!m.looksSolved) {
    lookRun = 0;
    return;
  }
  if (!lookRun) lookStartT = m.t;
  lookRun++;
  const track = controller.store.get().track;
  // 追跡が確かなうちは追跡の判定に任せる（2面だけ見えている PLL の途中などを完成と取り違えないように）
  const trusted = track?.status === "tracking";
  if (lookRun >= 3 && (!trusted || m.t - lookStartT > 1000)) finish(track, "look", lookStartT);
}

function splitsOf(start: CubeState, moves: TimedMove[], startT: number): Solve["splits"] {
  const sp = cfopSplits(start, moves.map((m) => m.move));
  return sp?.map((x) => ({ name: x.name, moves: x.index, t: x.index > 0 ? moves[x.index - 1].end - startT : 0 }));
}

function solveMoves(moves: TimedMove[], startT: number): Solve["moves"] {
  return moves.map((m) => ({
    m: MOVE_NAMES[m.move],
    r: MOVE_NAMES[relativeMove(m.move, viewOrient(m.orient))],
    t: Math.round(m.end - startT),
    s: Math.round(m.start - startT),
    ...(m.inferred ? { inferred: true } : {}),
  }));
}

function updateSolve(id: string, patch: Partial<Solve>): void {
  const solves = timerStore.get().solves.map((x) => (x.id === id ? { ...x, ...patch } : x));
  saveSolves(solves);
  const result = timerStore.get().result;
  timerStore.set({ solves, result: result?.id === id ? { ...result, ...patch } : result });
}

type StopReason = "tracked" | "look" | "manual";

function finish(u: TrackUpdate | null, how: StopReason, lookT?: number): void {
  const s = timerStore.get();
  const startState = target ?? solvedState();
  const endIndex = u?.moves.length ?? s.startIndex;
  const moves = u ? liveTimed(u, s.startIndex) : [];
  const stopT = performance.now();
  const endT = how === "tracked" && moves.length ? moves[moves.length - 1].end : how === "look" && lookT !== undefined ? lookT : stopT;
  const timeMs = Math.max(0, endT - s.startT);
  const inspectionMs = s.startT - s.inspectionStart;
  const penalty: Solve["penalty"] = settingsStore.get().inspection ? (inspectionMs > 17000 ? "DNF" : inspectionMs > 15000 ? "+2" : "") : "";
  const analyze = recording && controller.recorder.recording;
  const solve: Solve = {
    id: `${Date.now()}`,
    date: Date.now(),
    scramble: s.scramble.map((m) => MOVE_NAMES[m]).join(" "),
    timeMs,
    penalty,
    moves: solveMoves(moves, s.startT),
    tps: timeMs > 0 ? moves.length / (timeMs / 1000) : 0,
    splits: how === "tracked" ? splitsOf(startState, moves, s.startT) : undefined,
    tracked: how !== "manual",
    ...(analyze ? { analysis: "pending" as const, provisionalMs: timeMs } : {}),
  };
  const solves = [solve, ...s.solves];
  saveSolves(solves);
  controller.beep(1320, 0.2);
  target = null;
  recording = false;
  timerStore.set({ phase: "done", result: solve, solves, analysisProgress: 0 });
  const refs = controller.store.get().track?.refs ?? controller.store.get().cube?.refs;
  // 速報値の開始・終了（止めた後のフレームで更新し、精密解析で決めきれなかった端に使う）
  const live: LiveSpan = { id: solve.id, start: startState, startT: s.startT, endT, how };
  window.setTimeout(async () => {
    // 速報値を、止めた後のフレーム（最後の手が止まったところ）も使って更新する
    if (how === "tracked") await refreshLive(live, s.startIndex, endIndex);
    if (analyze && refs) analyzeRecording(live, refs, how === "manual" ? stopT : endT);
    else if (analyze) updateSolve(solve.id, { analysis: "failed" });
  }, POSTROLL_MS);
}

interface LiveSpan {
  id: string;
  start: CubeState;
  startT: number;
  endT: number;
  how: StopReason;
}

async function refreshLive(live: LiveSpan, from: number, to: number): Promise<void> {
  const u = await controller.vision?.query();
  if (!u || u.moves.length < to) return;
  const moves = liveTimed(u, from, to);
  if (!moves.length || !isSolved(applyMoves(live.start, moves.map((m) => m.move)))) return;
  const cur = timerStore.get().solves.find((x) => x.id === live.id);
  if (!cur || cur.analysis === "done") return;
  const begin = Math.min(live.startT, moves[0].start);
  live.startT = begin;
  live.endT = moves[moves.length - 1].end;
  const timeMs = Math.max(0, live.endT - begin);
  updateSolve(live.id, { timeMs, provisionalMs: timeMs, moves: solveMoves(moves, begin), tps: moves.length / Math.max(0.001, timeMs / 1000), splits: splitsOf(live.start, moves, begin) });
}

async function analyzeRecording(live: LiveSpan, refs: Lab[], endT: number): Promise<void> {
  const { id, start, startT, how } = live;
  const rec = controller.recorder;
  await rec.finish();
  const from = startT - PREROLL_MS;
  const to = endT + POSTROLL_MS - 100;
  const recording = rec.extract(from, to);
  // 調査用（E2E テストが読む）
  const debug: { recording: unknown; result?: RefineResult } = { recording: { frames: rec.frames, dropped: rec.dropped, chunks: recording?.chunks.length ?? 0 } };
  (window as unknown as { __cubevisionAnalysis?: unknown }).__cubevisionAnalysis = debug;
  rec.stop();
  if (!recording) {
    updateSolve(id, { analysis: "failed" });
    return;
  }
  const s = settingsStore.get();
  let result: RefineResult;
  try {
    result = await controller.refiner.run(
      recording,
      {
        state: Array.from(start),
        refs,
        from,
        to,
        startHint: startT,
        hands: controller.hands.historyBetween(from, to),
        engine: controller.engineOptions(),
        pipeline: { mode: s.detection },
      },
      (p) => timerStore.set({ analysisProgress: p }),
    );
  } catch (e) {
    console.warn("refine failed", e);
    updateSolve(id, { analysis: "failed" });
    return;
  } finally {
    rec.clear();
  }
  debug.result = result;
  // 手動で止めたときは、最後に足した（見えていない）手で完成にしたものは採らない
  const ok = result.solved && result.start !== null && result.end !== null && result.moves.length > 0 && (how !== "manual" || result.forced === 0);
  if (!ok) {
    updateSolve(id, { analysis: "failed" });
    return;
  }
  // 端の手が直接見えていなければ、その端はリアルタイムの追跡の時刻を使う
  const begin = result.startUncertain ? live.startT : result.start!;
  const finish = result.endUncertain ? (how === "manual" ? null : live.endT) : result.end!;
  if (finish === null) {
    updateSolve(id, { analysis: "failed" });
    return;
  }
  const timeMs = Math.max(0, finish - begin);
  updateSolve(id, {
    analysis: "done",
    timeMs,
    moves: solveMoves(result.moves, begin),
    tps: result.moves.length / Math.max(0.001, timeMs / 1000),
    splits: splitsOf(start, result.moves, begin),
    tracked: true,
  });
}

export function stopManually(): void {
  if (timerStore.get().phase !== "solving") return;
  finish(controller.store.get().track, "manual");
}

export function setPenalty(id: string, penalty: Solve["penalty"]): void {
  const solves = timerStore.get().solves.map((s) => (s.id === id ? { ...s, penalty } : s));
  saveSolves(solves);
  const result = timerStore.get().result;
  timerStore.set({ solves, result: result?.id === id ? { ...result, penalty } : result });
}

export function deleteSolve(id: string): void {
  const solves = timerStore.get().solves.filter((s) => s.id !== id);
  saveSolves(solves);
  timerStore.set({ solves, result: timerStore.get().result?.id === id ? null : timerStore.get().result });
}

export function replaceSolves(solves: Solve[]): void {
  saveSolves(solves);
  timerStore.set({ solves });
}

// インスペクションの音（8秒・12秒）
export function inspectionTick(now: number): number {
  const s = timerStore.get();
  if (s.phase !== "inspection") return 0;
  const elapsed = now - s.inspectionStart;
  if (settingsStore.get().inspection) {
    if (elapsed > 8000 && !warned8) {
      warned8 = true;
      controller.beep(700, 0.1);
    }
    if (elapsed > 12000 && !warned12) {
      warned12 = true;
      controller.beep(700, 0.25);
    }
  }
  return elapsed;
}

controller.onTrack(onTrack);
controller.onFrameResult(onFrame);

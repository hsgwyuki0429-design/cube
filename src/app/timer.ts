// スマートキューブ風のタイマー: スクランブル誘導 → インスペクション → 最初の1手で開始 → 完成で停止。
//
// 時間は「最初の手の回し始め」から「最後の手の回し終わり」まで（フレームの記録から、誤差はフレーム間隔の半分程度）。
// 止めた瞬間はリアルタイムの追跡からの速報値を出し、計測中に録画しておいた全フレームを別の Worker で
// 1枚ずつ解析し直して、数秒〜数十秒後に時間と手順を確定する（リアルタイムでは処理が追いつかないフレームも使う）。
import { cfopSplits } from "../cube/analysis";
import { type CubeState, MOVE_NAMES, applyMoves, isSolved, moveFace, relativeMove, rotateOrientation, solvedState, statesEqual } from "../cube/model";
import { randomScramble, solveBetween } from "../cube/solver";
import { StartDetector } from "./startDetect";
import { markPhase } from "./crashGuard";
import { ScrambleGuide, undoMoves } from "./scrambleGuide";
import type { TrackUpdate } from "../track/engine";
import { mergeQuickRepeats } from "../track/merge";
import type { RefineResult } from "../vision/refine";
import { controller } from "./controller";
import { settingsStore } from "./settings";
import { type Solve, loadSolves, saveSolves } from "./storage";
import { createStore } from "./store";

export type TimerPhase = "idle" | "preparing" | "scrambling" | "inspection" | "solving" | "done";

export interface TimerState {
  phase: TimerPhase;
  scramble: number[];
  guide: number[]; // スクランブルの案内（揃った状態からならスクランブルそのもの。途中で作り直さない）
  guideDone: number; // guide のうち済んだ手数
  guideHalf: boolean; // 次の手（半回転）を半分だけ回した
  guideFix: number[] | null; // 案内からずれたときに戻す手（空 = ずれていない。null = 近くに戻り道がない）
  recomputing: boolean; // 崩れた状態から始めたときの案内を計算中
  inspectionStart: number;
  startT: number;
  startIndex: number;
  liveMoves: number;
  result: Solve | null;
  solves: Solve[];
  message: string | null;
  analysisProgress: number; // 精密解析の進み具合（0..1）
  analysisStartedAt: number; // 精密解析を始めた時刻（残り時間の目安に使う）
}

export const timerStore = createStore<TimerState>({
  phase: "idle",
  scramble: [],
  guide: [],
  guideDone: 0,
  guideHalf: false,
  guideFix: [],
  recomputing: false,
  inspectionStart: 0,
  startT: 0,
  startIndex: 0,
  liveMoves: 0,
  result: null,
  solves: loadSolves(),
  message: null,
  analysisProgress: 0,
  analysisStartedAt: 0,
});

let target: CubeState | null = null;
let guide: ScrambleGuide | null = null;
let onPathMoves = 0; // 最後に案内の道筋の上にいたときの、追跡の手の数（戻り道が見つからないときに、その後の手を逆にたどる）
let readyMoves = 0;
let warned8 = false;
let warned12 = false;
let recording = false;
let lookRun = 0;
let lookStartT = 0;
let replanKey = ""; // スクランブルの案内を作り直した追跡の状態（同じ状態で何度も作り直さない）
const startDetector = new StartDetector(); // インスペクション中に回し始めたか（src/app/startDetect.ts）

const POSTROLL_MS = 1200; // 止めた後も録画を続ける時間（最後の手の回し終わりを確かめる）

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
  guide = new ScrambleGuide(from, moves);
  onPathMoves = controller.store.get().track?.moves.length ?? 0;
  timerStore.set({ guide: moves, guideDone: 0, guideHalf: false, guideFix: [], recomputing: false });
}

// 次に回す手（案内の表示・デモ）: 戻す手があればその先頭、半回転の途中なら残りの 1/4 回転
export function nextGuideMove(t: TimerState): number | null {
  if (t.guideFix === null) return null;
  if (t.guideFix.length) return t.guideFix[0];
  const m = t.guide[t.guideDone];
  if (m === undefined) return null;
  return t.guideHalf ? moveFace(m) * 3 : m;
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
  if (recording) controller.cancelAnalysis();
  recording = false;
  timerStore.set({ phase: "idle", guide: [], scramble: [], message: null });
}

function onTrack(u: TrackUpdate): void {
  const s = timerStore.get();
  const state = Uint8Array.from(u.state);
  if (s.phase === "scrambling" && target) {
    if (statesEqual(state, target)) {
      readyMoves = u.moves.length;
      startDetector.reset(u.base?.n ?? 0);
      warned8 = warned12 = false;
      controller.beep(660, 0.15);
      timerStore.set({ phase: "inspection", inspectionStart: performance.now(), guideDone: s.guide.length, guideHalf: false, guideFix: [], recomputing: false });
      recording = false;
      // 精密解析をここ（スクランブルの状態が分かっている所）から進める。止めたときには大半が終わっている
      controller.startAnalysis({ state, keep: readyMoves, timed: true }).then((ok) => {
        recording = ok && timerStore.get().phase !== "idle";
        if (recording) markPhase("solving");
      });
      return;
    }
    if (!guide || s.recomputing) return;
    const pos = guide.locate(state, s.guideDone);
    let fix = pos.fix;
    if (fix && !fix.length) onPathMoves = u.moves.length;
    // 近くに戻り道がない（追跡がしばらく見失っていた）: 道筋から外れた後に読めた手を逆にたどる。
    // 見えている色に合わせて作り変えた後（手順がつながらない）・たどる手がないときは、いまの状態からスクランブルの状態までを
    // 1 回だけ作り直す（作り変えで状態が飛ぶと、戻し方のないまま案内が止まっていた）
    const snapped = !!u.base && u.base.at >= onPathMoves;
    if (fix === null && (snapped || u.moves.length <= onPathMoves)) {
      const key = `${u.base?.n ?? 0}:${u.moves.length}`;
      if (replanKey !== key && target) {
        replanKey = key;
        const want = target;
        timerStore.set({ recomputing: true });
        solveBetween(state, want)
          .then((ms) => {
            if (timerStore.get().phase === "scrambling" && target === want) setGuide(state, ms);
          })
          .catch(() => timerStore.set({ recomputing: false }));
      }
      return;
    }
    if (fix === null) fix = undoMoves(u.moves.slice(onPathMoves).map((m) => m.move));
    timerStore.set({ guideDone: pos.done, guideHalf: pos.half, guideFix: fix });
    return;
  }
  if (s.phase === "inspection") {
    // 回し始めたか: 最初の手が確定して層が動いたのを見たか、スクランブルの状態から外れたまま続いたとき（src/app/startDetect.ts）
    const startT = startDetector.push(u, target, readyMoves);
    if (startT === null) return;
    timerStore.set({ phase: "solving", startT, startIndex: readyMoves, liveMoves: Math.max(0, u.moves.length - readyMoves) });
    controller.recorder.keepMs = 150000;
    lookRun = 0;
    controller.beep(990, 0.08);
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
    // ソルブ中に見えている色に合わせて作り変えた（手順がつながらない）ときは、分割タイムは精密解析で決める
    splits: how === "tracked" && !(u?.base && u.base.at > s.startIndex) ? splitsOf(startState, moves, s.startT) : undefined,
    tracked: how !== "manual",
    ...(analyze ? { analysis: "pending" as const, provisionalMs: timeMs } : {}),
  };
  const solves = [solve, ...s.solves];
  saveSolves(solves);
  controller.beep(1320, 0.2);
  target = null;
  recording = false;
  timerStore.set({ phase: "done", result: solve, solves, analysisProgress: 0 });
  // 速報値の開始・終了（止めた後のフレームで更新し、精密解析で決めきれなかった端に使う）
  const live: LiveSpan = { id: solve.id, start: startState, startT: s.startT, endT, how };
  window.setTimeout(async () => {
    // 速報値を、止めた後のフレーム（最後の手が止まったところ）も使って更新する
    if (how === "tracked") await refreshLive(live, s.startIndex, endIndex);
    // 次のソルブ（とフリーの追跡）のための解析は、この解析が終わってから始める（同じ解析の Worker で取り合うと、確定が数倍遅れた）
    if (analyze) void analyzeRecording(live, how === "manual" ? stopT : endT);
    else controller.cancelAnalysis();
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
  // 回し始めは、層が動き出したフレームが分かったときだけ更新する（分からない手の開始は前の読みが最後に見えた時刻で、指で隠して
  // いた間が長いとその分だけ前になり、タイムが長くなっていた）
  const first = u.timings?.[from];
  const begin = first?.exact ? Math.max(first.start, live.startT - 600) : live.startT;
  live.startT = begin;
  live.endT = moves[moves.length - 1].end;
  const timeMs = Math.max(0, live.endT - begin);
  updateSolve(live.id, { timeMs, provisionalMs: timeMs, moves: solveMoves(moves, begin), tps: moves.length / Math.max(0.001, timeMs / 1000), splits: splitsOf(live.start, moves, begin) });
}

async function analyzeRecording(live: LiveSpan, endT: number): Promise<void> {
  // 解析の段階の印を残す（落ちずに終わったら消す。落ちたら次から軽くする: src/app/crashGuard.ts）
  markPhase("finishing");
  try {
    await analyzeRecordingInner(live, endT);
  } finally {
    markPhase(null);
  }
}

async function analyzeRecordingInner(live: LiveSpan, endT: number): Promise<void> {
  const { id, start, how } = live;
  const rec = controller.recorder;
  const to = endT + POSTROLL_MS - 100;
  // インスペクションから進めてきた解析に、止めた所までの録画を渡し切り、完成の状態で解き直す
  const pending = await controller.endAnalysis(to, solvedState(), (p) => timerStore.set({ analysisProgress: p }));
  // 調査用（E2E テストが読む）
  const debug: { recording: unknown; result?: RefineResult } = { recording: { frames: rec.frames, dropped: rec.dropped } };
  (window as unknown as { __cubevisionAnalysis?: unknown }).__cubevisionAnalysis = debug;
  if (!pending) {
    updateSolve(id, { analysis: "failed" });
    return;
  }
  let result: RefineResult;
  timerStore.set({ analysisStartedAt: performance.now(), analysisProgress: 0 });
  try {
    result = await pending;
  } catch (e) {
    console.warn("refine failed", e);
    updateSolve(id, { analysis: "failed" });
    return;
  }
  markPhase("saving");
  debug.result = result;
  // 手動で止めたときは、最後に足した（見えていない）手で完成にしたものは採らない
  const ok = result.solved && result.start !== null && result.end !== null && result.moves.length > 0 && (how !== "manual" || result.forced === 0);
  if (!ok) {
    updateSolve(id, { analysis: "failed" });
    return;
  }
  // 端の手が直接見えていなければ、その端はリアルタイムの追跡の時刻を使う。ただし、リアルタイムが最初の数手を
  // 取りこぼしていた（解析で見つかった最初の手より後に始まっていた）なら、どちらの開始も信用できないので確定しない
  if (result.startUncertain && live.startT > result.moves[0].end) {
    updateSolve(id, { analysis: "failed" });
    return;
  }
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

// 動画ファイル（スロー撮影など）の精密解析の結果を記録に足す。scramble: 揃った状態から回したスクランブル（動画の始まりの状態）。
// 最初・最後の手が直接見えていない（時刻をフレームから決められない）・完成にたどり着かないときは足さず、理由を返す
export function addVideoSolve(result: RefineResult, scramble: number[]): { solve: Solve } | { error: string } {
  if (!result.solved || !result.moves.length || result.start === null || result.end === null) return { error: "完成までの手順をつなげられませんでした" };
  if (result.forced > 0) return { error: "最後の手が動画に写っていません（完成させるために見えない手を足しました）" };
  if (result.startUncertain) return { error: "最初の手が動画に写っていません（撮影を始めるのが遅かった・指で隠れていた）ので、タイムを決められません" };
  if (result.endUncertain) return { error: "最後の手が動画に写っていません（指で隠れていた・撮影を止めるのが早かった）ので、タイムを決められません" };
  const start = applyMoves(solvedState(), scramble);
  const begin = result.start;
  const timeMs = Math.max(0, result.end - begin);
  const solve: Solve = {
    id: `${Date.now()}`,
    date: Date.now(),
    scramble: scramble.map((m) => MOVE_NAMES[m]).join(" "),
    timeMs,
    penalty: "",
    moves: solveMoves(result.moves, begin),
    tps: result.moves.length / Math.max(0.001, timeMs / 1000),
    splits: splitsOf(start, result.moves, begin),
    tracked: true,
    analysis: "done",
    video: true,
  };
  const solves = [solve, ...timerStore.get().solves];
  saveSolves(solves);
  timerStore.set({ solves });
  return { solve };
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

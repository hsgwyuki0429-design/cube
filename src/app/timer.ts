// スマートキューブ風のタイマー: スクランブル誘導 → インスペクション → 最初の1手で開始 → 完成で停止。
import { cfopSplits } from "../cube/analysis";
import { type CubeState, MOVE_NAMES, applyMoves, isSolved, relativeMove, rotateOrientation, solvedState, statesEqual } from "../cube/model";
import { randomScramble, solveBetween } from "../cube/solver";
import type { TrackUpdate } from "../track/engine";
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
});

let target: CubeState | null = null;
let guideStates: CubeState[] = [];
let readyMoves = 0;
let recomputeTimer = 0;
let warned8 = false;
let warned12 = false;

const viewOrient = (o: number) => (settingsStore.get().viewpoint === "user" ? rotateOrientation(o, "y", 2) : o);

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
      timerStore.set({ phase: "solving", startT: first.t, startIndex: readyMoves, liveMoves: u.moves.length - readyMoves });
      controller.beep(990, 0.08);
    }
    return;
  }
  if (s.phase === "solving") {
    timerStore.set({ liveMoves: Math.max(0, u.moves.length - s.startIndex) });
    if (u.solved) finish(u, true);
  }
}

function finish(u: TrackUpdate | null, tracked: boolean): void {
  const s = timerStore.get();
  const moves = u ? u.moves.slice(s.startIndex) : [];
  const endT = tracked && moves.length ? moves[moves.length - 1].t : performance.now();
  const timeMs = Math.max(0, endT - s.startT);
  const inspectionMs = s.startT - s.inspectionStart;
  const penalty: Solve["penalty"] = settingsStore.get().inspection ? (inspectionMs > 17000 ? "DNF" : inspectionMs > 15000 ? "+2" : "") : "";
  let splits: Solve["splits"];
  if (tracked && target) {
    const sp = cfopSplits(target, moves.map((m) => m.move));
    if (sp) splits = sp.map((x) => ({ name: x.name, moves: x.index, t: x.index > 0 ? moves[x.index - 1].t - s.startT : 0 }));
  }
  const solve: Solve = {
    id: `${Date.now()}`,
    date: Date.now(),
    scramble: s.scramble.map((m) => MOVE_NAMES[m]).join(" "),
    timeMs,
    penalty,
    moves: moves.map((m) => ({ m: MOVE_NAMES[m.move], r: MOVE_NAMES[relativeMove(m.move, viewOrient(m.orient))], t: m.t - s.startT, ...(m.inferred ? { inferred: true } : {}) })),
    tps: timeMs > 0 ? moves.length / (timeMs / 1000) : 0,
    splits,
    tracked,
  };
  const solves = [solve, ...s.solves];
  saveSolves(solves);
  controller.beep(1320, 0.2);
  target = null;
  timerStore.set({ phase: "done", result: solve, solves });
}

export function stopManually(): void {
  if (timerStore.get().phase !== "solving") return;
  finish(controller.store.get().track, false);
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

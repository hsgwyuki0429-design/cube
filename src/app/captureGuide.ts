// 撮り方の案内を画面につなぐ: 認識の結果（FrameMessage）から見え方を 1 秒に 4 回まとめて CaptureAdvisor（src/app/captureAdvice.ts）に渡し、
// 今出す注意を adviceStore に置く（プレイ画面が 1 行で出す）。ソルブ中は面が組めたか・読めたマスだけを数え、止めたらソルブの後の注意を決める。
// ライブの処理は重くしない（見え方の計算はメインスレッドで 250ms に 1 回。明るさは認識の Worker が 250ms に 1 回）
import { type AdviceKey, CaptureAdvisor, type SolveStats } from "./captureAdvice";
import { viewMetrics } from "../vision/captureMetrics";
import { controller } from "./controller";
import { settingsStore } from "./settings";
import { createStore } from "./store";
import { timerStore } from "./timer";
import type { FrameMessage } from "../vision/protocol";

export const adviceStore = createStore<{ key: AdviceKey | null; stats: SolveStats | null }>({ key: null, stats: null });

const EVERY_MS = 250;
const advisor = new CaptureAdvisor();
let lastSample = -Infinity;
let lastLight: { cube: number; frame: number } | undefined;
// ソルブ中の数え: フレーム・面なし・読めたマス・面の辺（250ms ごと）・明るさ
let solve = { frames: 0, noFace: 0, cells: 0, edges: [] as number[], lights: [] as number[], lastEdge: -Infinity };

const quietPhase = (p: string) => p === "inspection" || p === "solving";

function onFrame(m: FrameMessage): void {
  if (m.light) lastLight = m.light;
  const phase = timerStore.get().phase;
  if (phase === "solving") {
    // 面が 1 つも組めなかったフレーム（1 列・1 枚の面だけも含む）と、ID が読めたマス
    solve.frames++;
    const faces = m.sight?.faces.filter((f) => !f.held).length ?? 0;
    if (!faces) solve.noFace++;
    for (const f of m.faces) for (const id of f.ids ?? []) if (id >= 0) solve.cells++;
    if (m.light) solve.lights.push(m.light.cube);
    if (faces && m.t - solve.lastEdge >= EVERY_MS) {
      solve.lastEdge = m.t;
      solve.edges.push(viewMetrics(m.sight, m.width, m.height).faceEdge);
    }
    return;
  }
  if (quietPhase(phase) || m.t - lastSample < EVERY_MS) return;
  lastSample = m.t;
  advisor.height = m.height;
  advisor.push({ t: m.t, view: viewMetrics(m.sight, m.width, m.height), light: lastLight });
}

const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : Number.NaN);

let prevPhase = timerStore.get().phase;
timerStore.subscribe((t) => {
  if (t.phase === prevPhase) return;
  if (t.phase === "solving") solve = { frames: 0, noFace: 0, cells: 0, edges: [], lights: [], lastEdge: -Infinity };
  if (prevPhase === "solving" && t.phase === "done") {
    const stats: SolveStats = { frames: solve.frames, noFace: solve.frames ? solve.noFace / solve.frames : 0, cells: solve.frames ? solve.cells / solve.frames : 0, faceEdge: med(solve.edges), light: solve.lights.length ? med(solve.lights) : null };
    advisor.solveEnded(stats, performance.now());
    adviceStore.set({ stats });
  }
  prevPhase = t.phase;
  tick();
});

function tick(): void {
  const on = settingsStore.get().captureAdvice && controller.store.get().camera === "on";
  if (!on) advisor.clear();
  const key = on ? advisor.update(performance.now(), quietPhase(timerStore.get().phase)) : null;
  if (key !== adviceStore.get().key) adviceStore.set({ key });
}

controller.onFrameResult(onFrame);
if (typeof window !== "undefined") window.setInterval(tick, EVERY_MS);

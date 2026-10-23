// デモの台本: 合成キューブがスキャンの指示どおりに面を見せ、スキャン後はスクランブル → 解く を繰り返す。
// アプリ側は本物のカメラと同じ経路（Worker で画像認識 → 追跡）で処理する。
import { B, F, NUM_MOVES, U, invertMoves, moveFace } from "../cube/model";
import { solveState } from "../cube/solver";
import type { Controller } from "../app/controller";
import type { SyntheticCube } from "./syntheticCube";

const TOP_FOR: Record<number, number> = { 0: B, 1: U, 2: U, 3: F, 4: U, 5: U };

export function seededRandom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

export function randomMoves(n: number, rnd: () => number): number[] {
  const out: number[] = [];
  while (out.length < n) {
    const m = Math.floor(rnd() * NUM_MOVES);
    if (out.length && moveFace(out[out.length - 1]) === moveFace(m)) continue;
    out.push(m);
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > timeoutMs) return false;
    await sleep(50);
  }
  return true;
}

export interface DemoOptions {
  e2eMoves?: number; // 指定するとその手数だけ回して止まる（テスト用）
  timer?: boolean; // タイマーの流れ（スクランブル誘導 → 解く）をテストする
  tps?: number;
  view?: "top" | "corner" | "front";
}

export async function runDemo(app: Controller, syn: SyntheticCube, seed = Date.now() % 100000, options: DemoOptions = {}): Promise<void> {
  const rnd = seededRandom(seed);
  const scramble = randomMoves(20, rnd);
  syn.setStateInstant(scramble);
  syn.setView("front", 0);
  await sleep(300);
  await waitFor(() => app.store.get().vision !== "loading", 60000);

  // 1) スキャン: 指示された面を見せる
  app.beginScan();
  for (let i = 0; i < 6; i++) {
    const scan = app.store.get().scan;
    if (!scan || app.synthetic !== syn) return;
    const face = scan.steps[i].face;
    await syn.showFace(face, TOP_FOR[face], 900);
    const ok = await waitFor(() => (app.store.get().scan?.captured.length ?? 0) > i || app.synthetic !== syn, 15000);
    if (!ok || app.synthetic !== syn) return;
  }
  await waitFor(() => !!app.store.get().scan?.result, 5000);
  await sleep(1200);
  app.confirmScan();

  // 2) 追跡: 2面が見える位置に構えて回す
  syn.setView(options.view ?? "top", 1200);
  await syn.showFace(F, U, 900);
  await sleep(1500);
  const tps = options.tps ?? 2.2;
  const turn = (m: number) => syn.move(m, Math.min(260, 1000 / tps / 1.6)).then(() => sleep(1000 / tps));

  if (options.timer) {
    const { newScramble, timerStore } = await import("../app/timer");
    app.store.set({ panel: "timer" });
    await newScramble();
    // 案内された手順どおりに崩す（案内は状態に応じて更新されるので、毎回先頭の未完了の手を回す）
    for (let guard = 0; guard < 80 && timerStore.get().phase === "scrambling"; guard++) {
      const t = timerStore.get();
      if (t.recomputing || t.guideDone >= t.guide.length) {
        await sleep(200);
        continue;
      }
      const target = t.guide.length;
      const next = t.guide[t.guideDone];
      await turn(next);
      await waitFor(() => timerStore.get().phase !== "scrambling" || timerStore.get().guideDone > t.guideDone || timerStore.get().guide.length !== target, 3000);
    }
    await waitFor(() => timerStore.get().phase === "inspection", 5000);
    await sleep(1500);
    const solution = await solveState(syn.state);
    syn.solveFrom = syn.truth.length;
    for (const m of solution) await turn(m);
    await waitFor(() => timerStore.get().phase === "done", 8000);
    return;
  }

  if (options.e2eMoves) {
    for (const m of randomMoves(options.e2eMoves, rnd)) {
      if (app.synthetic !== syn) return;
      await turn(m);
    }
    return;
  }

  // 解いて、崩して、を繰り返す
  for (;;) {
    if (app.synthetic !== syn) return;
    const sol = await solveState(syn.state).catch(() => invertMoves(scramble));
    for (const m of sol) {
      if (app.synthetic !== syn) return;
      await turn(m);
    }
    await sleep(2500);
    if (app.synthetic !== syn) return;
    // 時々持ち替え
    await syn.showFace(F, U, 700);
    for (const m of randomMoves(14, rnd)) {
      if (app.synthetic !== syn) return;
      await turn(m);
    }
    await sleep(1500);
  }
}

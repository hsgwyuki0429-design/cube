// 新しい追跡器（src/track/sight/tracker.ts）と今のライブの追跡（TrackerEngine + 本体のライブの設定）を、同じ読みで比べる。
// 読みは realVideo.debug.test.ts の REAL_READINGS（全フレーム）を 1 秒 N 枚に間引いたもの（間引いたフレームの読みは、本当に 1 秒 N 枚で
// 処理したときと少し違う: 面の格子で追う所。どちらの追跡器にも同じ読みを渡すので、比べるのには使える）。
// 本当の状態は精密解析の手順と時刻（REAL_REF）。3D に出した状態が、遅れを 300ms まで許して本当の状態と同じだった時間の割合を出す。
//   SR_DIR=dump npx vitest run -c vitest.debug.config.ts tests/debug/sightReplay.debug.test.ts --silent=false
//   SR_FPS=6,10,15,20,0（0 = 全フレーム）・SR_ONLY=正規表現・SR_OPT='{"beam":64}'（新しい追跡器の設定）・SR_OLD=0（今の追跡を省く）
import { readFileSync, readdirSync } from "node:fs";
import { it } from "vitest";
import { ARUCO_REFS } from "../../src/aruco/palette";
import { type CubeState, applyMove, statesEqual } from "../../src/cube/model";
import { TrackerEngine } from "../../src/track/engine";
import type { FrameReading } from "../../src/track/observer";
import type { SightFrame } from "../../src/track/pieces/frame";
import { slotsPlausible } from "../../src/track/pieces/slotCheck";
import { type SightInput, SightTracker } from "../../src/track/sight/tracker";
import { liveEngineOptions } from "./liveReplay.debug.test";

type Ref = { moves: { move: number; start: number; end: number }[]; start?: number; end?: number };

// 時刻 t に出した状態 shown が、t − lag〜t のどこかの本当の状態（回し始めた手は回し終えたとみなしてもよい）と同じか
export function matchesTruth(start: CubeState, res: Ref, t: number, lag: number, shown: CubeState): boolean {
  let st: CubeState = start;
  for (let j = 0; j <= res.moves.length; j++) {
    const began = j === 0 || res.moves[j - 1].start <= t;
    const still = j === res.moves.length || res.moves[j].end > t - lag;
    if (began && still && statesEqual(st, shown)) return true;
    if (!began) return false;
    if (j < res.moves.length) st = applyMove(st, res.moves[j].move);
  }
  return false;
}

export function sightInputOf(r: FrameReading & { sight?: SightFrame }): SightInput {
  const sight = new Map((r.sight?.faces ?? []).map((f) => [f.slot, f]));
  return { t: r.t, faces: r.faces.map((f) => ({ slot: f.slot, ids: f.ids, weight: f.weight, rot: sight.get(f.slot)?.rot, held: sight.get(f.slot)?.held })) };
}

export function subsample<T extends { t: number }>(rs: T[], fps: number): T[] {
  if (!fps) return rs;
  const out: T[] = [];
  let next = -Infinity;
  for (const r of rs)
    if (r.t >= next - 1) {
      out.push(r);
      next = r.t + 1000 / fps;
    }
  return out;
}

it("新しい追跡器とライブの追跡の比較", () => {
  const dir = process.env.SR_DIR;
  if (!dir) return;
  const fpss = (process.env.SR_FPS ?? "6,10,15,20,0").split(",").map(Number);
  const opt = JSON.parse(process.env.SR_OPT ?? "{}");
  const runOld = process.env.SR_OLD !== "0";
  const sum = { old: 0, neu: 0, n: 0, msOld: 0, msNew: 0, frames: 0 };
  const lines: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith("_orig.live.json") && new RegExp(process.env.SR_ONLY ?? ".").test(x)).sort()) {
    const name = f.replace("_orig.live.json", "");
    let res: Ref;
    try {
      res = JSON.parse(readFileSync(`${dir}/${name}_orig.ref.json`, "utf8"));
    } catch {
      continue;
    }
    const loaded = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as { start: number[]; readings: (FrameReading & { sight?: SightFrame })[] };
    let readings = loaded.readings;
    let st0: CubeState = Uint8Array.from(loaded.start);
    // SR_SOLVE=1: 本体のタイマーと同じく、インスペクションの後（手の間がいちばん長く開いた所: 2 秒以上）から、始まりの状態を知って追う
    if (process.env.SR_SOLVE === "1") {
      let k = 0;
      let gap = 2000;
      for (let i = 1; i < res.moves.length; i++)
        if (res.moves[i].start - res.moves[i - 1].end > gap) {
          gap = res.moves[i].start - res.moves[i - 1].end;
          k = i;
        }
      for (let i = 0; i < k; i++) st0 = applyMove(st0, res.moves[i].move);
      const from = res.moves[k].start - 1500;
      readings = readings.filter((r) => r.t >= from);
      res = { moves: res.moves.slice(k) };
    }
    const s0 = res.moves[0]?.start ?? Infinity;
    const s1 = (res.moves[res.moves.length - 1]?.end ?? -Infinity) + 1000;
    for (const fps of fpss) {
      const rs = subsample(readings, fps);
      const engine = runOld ? new TrackerEngine(st0, ARUCO_REFS, liveEngineOptions()) : null;
      const tracker = new SightTracker(st0, opt);
      const acc = { old: 0, neu: 0, counted: 0 };
      let msOld = 0;
      let msNew = 0;
      let maxNew = 0;
      for (let i = 0; i < rs.length; i++) {
        let r = rs[i];
        let a = performance.now();
        if (engine) {
          if (r.sight && r.faces.length && !slotsPlausible(r.sight)) r = { ...r, faces: [] };
          engine.push(r);
        }
        msOld += performance.now() - a;
        a = performance.now();
        const ri = rs[i];
        tracker.push(process.env.SR_SLOTCHECK !== "0" && ri.sight && ri.faces.length && !slotsPlausible(ri.sight) ? { t: ri.t, faces: [] } : sightInputOf(ri));
        const dms = performance.now() - a;
        msNew += dms;
        maxNew = Math.max(maxNew, dms);
        const t = r.t;
        if (process.env.SR_DUMP && fps === fpss[0]) {
          const b = tracker.best();
          let n = 0;
          for (let x = b.tail; x; x = x.prev) n++;
          console.log(`${(t / 1000).toFixed(3)} ${matchesTruth(st0, res, t, 300, tracker.state()) ? "=" : "≠"} o${b.o} fc ${b.frameCost.toFixed(1)} 手 ${n} 2位 ${(tracker.hyps[1]?.cost ?? 0).toFixed(1)} 評価 ${tracker.expanded} ${rs[i].faces.map((f) => `${f.slot}:${(f.ids ?? []).map((x) => (x >= 0 ? x : ".")).join(",")}`).join(" ")}`);
        }
        if (t < s0 || t > s1) continue;
        const dt = (rs[i + 1]?.t ?? t) - t;
        acc.counted += dt;
        if (engine && matchesTruth(st0, res, t, 300, Uint8Array.from(engine.view?.state ?? engine.decoder.best().state))) acc.old += dt;
        if (matchesTruth(st0, res, t, 300, tracker.view?.state ?? tracker.state())) acc.neu += dt;
      }
      const pOld = acc.old / Math.max(1, acc.counted);
      const pNew = acc.neu / Math.max(1, acc.counted);
      sum.old += pOld;
      sum.neu += pNew;
      sum.n++;
      sum.msOld += msOld;
      sum.msNew += msNew;
      sum.frames += rs.length;
      lines.push(`${name} ${fps ? `${fps} 枚/秒` : "全フレーム"}`.padEnd(22) + ` 今 ${(pOld * 100).toFixed(1).padStart(5)}%・新 ${(pNew * 100).toFixed(1).padStart(5)}% | 追跡 今 ${(msOld / rs.length).toFixed(2)}ms・新 ${(msNew / rs.length).toFixed(2)}ms（最大 ${maxNew.toFixed(0)}ms）・作り変え ${tracker.snaps}・復帰 ${tracker.recoveries}`);
    }
  }
  lines.push(`平均（${sum.n} 通り） 今 ${((sum.old / Math.max(1, sum.n)) * 100).toFixed(1)}%・新 ${((sum.neu / Math.max(1, sum.n)) * 100).toFixed(1)}% | 追跡 今 ${(sum.msOld / Math.max(1, sum.frames)).toFixed(2)}ms・新 ${(sum.msNew / Math.max(1, sum.frames)).toFixed(2)}ms/フレーム`);
  console.log(lines.join("\n"));
}, 7200000);

// 書き出したライブの読み（realVideo.debug.test.ts の REAL_READINGS: 実物の動画でライブが処理したフレームの認識の結果）を、ライブの
// 追跡（観測器 + デコーダ + 作り変え）だけに通し直して、3D に出した状態が精密解析の状態（REAL_REF で書き出したもの）と同じだった時間の
// 割合を出す。認識は追跡の結果に依らないので、追跡だけを直して何度も測るときに速い（1 本 1 秒ほど）。
//   LIVE_SETS="4972-10:ref-4972.json,4970-10:ref-4970.json"（読みのファイル:精密解析の結果。LIVE_DIR からの相対）
//   LIVE_ENGINE='{"decoder":{"maxMovesPerStep":4}}'（本体のライブの設定に上書き）・LIVE_DUMP=1（観測ごと）
import { readFileSync } from "node:fs";
import { it } from "vitest";
import { ARUCO_REFS } from "../../src/aruco/palette";
import { MOVE_NAMES, applyMove, statesEqual } from "../../src/cube/model";
import { type EngineOptions, TrackerEngine } from "../../src/track/engine";
import { simplifyMoves } from "../../src/track/merge";
import { ARUCO_OBSERVER, type FrameReading, LIVE_OBSERVER } from "../../src/track/observer";
import type { RefineResult } from "../../src/vision/refine";
import type { SightFrame } from "../../src/track/pieces/frame";
import { slotsPlausible } from "../../src/track/pieces/slotCheck";

const LAGS = [150, 300, 600];

export function liveEngineOptions(over: Partial<EngineOptions> = {}): Partial<EngineOptions> {
  // 本体のライブ（src/app/controller.ts の liveEngineOptions）
  return { ...over, observer: { ...ARUCO_OBSERVER, ...LIVE_OBSERVER, ...over.observer }, decoder: { priorWeight: 0, confirmMargin: 1, deepHyps: 4, bridgeDepth: 5, ...over.decoder }, snapToView: over.snapToView ?? true };
}

// 時刻 t に出した状態 shown が、t - lag〜t のどこかの本当の状態（回し始めた手は回し終えたとみなしてもよい）と同じか
function matches(start: Uint8Array, res: RefineResult, t: number, lag: number, shown: Uint8Array): boolean {
  let st: Uint8Array = start;
  for (let j = 0; j <= res.moves.length; j++) {
    const began = j === 0 || res.moves[j - 1].start <= t;
    const still = j === res.moves.length || res.moves[j].end > t - lag;
    if (began && still && statesEqual(st, shown)) return true;
    if (!began) return false;
    if (j < res.moves.length) st = applyMove(st, res.moves[j].move);
  }
  return false;
}

it("書き出したライブの読みの追跡", () => {
  const sets = (process.env.LIVE_SETS ?? "").split(",").filter(Boolean);
  const dir = process.env.LIVE_DIR ?? ".";
  const over = JSON.parse(process.env.LIVE_ENGINE ?? "{}") as Partial<EngineOptions>;
  const totals = LAGS.map(() => ({ same: 0, counted: 0 }));
  let meanSum = 0;
  const lines: string[] = [];
  for (const set of sets) {
    const [rd, rf] = set.split(":");
    const { start, readings } = JSON.parse(readFileSync(`${dir}/${rd}`, "utf8")) as { start: number[]; readings: FrameReading[] };
    const res = JSON.parse(readFileSync(`${dir}/${rf}`, "utf8")) as RefineResult;
    const st0 = Uint8Array.from(start);
    const engine = new TrackerEngine(st0, ARUCO_REFS, liveEngineOptions(over));
    const s0 = res.start ?? res.moves[0]?.start ?? Infinity;
    const s1 = (res.end ?? res.moves[res.moves.length - 1]?.end ?? -Infinity) + 1000;
    const acc = LAGS.map(() => ({ same: 0, counted: 0 }));
    let ms = 0;
    let evals = 0;
    let obs = 0;
    let snaps = 0;
    let lastBase = 0;
    let dropped = 0;
    for (let i = 0; i < readings.length; i++) {
      let r = readings[i];
      // LIVE_SLOTCHECK=1: スロットがありえないフレームの面を捨てる（src/track/pieces/slotCheck.ts）
      const sight = (r as FrameReading & { sight?: SightFrame }).sight;
      if (process.env.LIVE_SLOTCHECK && sight && r.faces.length && !slotsPlausible(sight)) {
        r = { ...r, faces: [] };
        dropped++;
      }
      // LIVE_FRAG=3: センターが読めず、ID が読めたマスがこれ以下の面（欠片）を捨てる
      const frag = Number(process.env.LIVE_FRAG ?? 0);
      if (frag && r.faces.length) {
        const faces = r.faces.filter((f) => {
          const ids = f.ids ?? [];
          if (ids[4] >= 0 && ids[4] % 9 === 4 && f.valid[4]) return true;
          return ids.filter((x, c) => x >= 0 && f.valid[c]).length > frag;
        });
        if (faces.length !== r.faces.length) r = { ...r, faces };
      }
      const a = performance.now();
      const u = engine.push(r);
      ms += performance.now() - a;
      if (u) {
        obs++;
        evals += engine.decoder.lastExpanded;
      }
      if (engine.base && engine.base.n !== lastBase) snaps++;
      lastBase = engine.base?.n ?? 0;
      const best = engine.decoder.best();
      const shown = Uint8Array.from(engine.view?.state ?? best.state);
      if (process.env.LIVE_DUMP === "2" && !u) process.stdout.write(`${(r.t / 1000).toFixed(3)}   - ${r.faces.map((f) => `${f.slot}:${(f.ids ?? []).map((id, c) => (f.valid[c] && id >= 0 ? id : ".")).join(",")}`).join(" ")}\n`);
      if (process.env.LIVE_DUMP && u)
        process.stdout.write(
          `${(r.t / 1000).toFixed(3)} ${matches(st0, res, r.t, 300, shown) ? "=" : "≠"} ${engine.decoder.status} ${u.obsCost.toFixed(1)} ${engine.base?.n ?? 0}/${engine.view?.n ?? 0} ${r.faces.map((f) => `${f.slot}:${(f.ids ?? []).map((id, c) => (f.valid[c] && id >= 0 ? id : ".")).join(",")}`).join(" ")} | ${engine.decoder.bestMoves().slice(-10).map((m) => MOVE_NAMES[m.move]).join(" ")}\n`,
        );
      if (r.t < s0 || r.t > s1) continue;
      const dt = (readings[i + 1]?.t ?? r.t) - r.t;
      LAGS.forEach((lag, k) => {
        acc[k].counted += dt;
        if (matches(st0, res, r.t, lag, shown)) acc[k].same += dt;
      });
    }
    meanSum += acc[1].same / Math.max(1, acc[1].counted);
    LAGS.forEach((_, k) => {
      totals[k].same += acc[k].same;
      totals[k].counted += acc[k].counted;
    });
    const moves = simplifyMoves(engine.decoder.bestMoves());
    const truth = res.moves.map((m) => MOVE_NAMES[m.move]).join(" ");
    const got = moves.map((m) => MOVE_NAMES[m.move]).join(" ");
    // 手順の頭から何手まで精密解析と同じか
    let same = 0;
    while (same < moves.length && same < res.moves.length && moves[same].move === res.moves[same].move) same++;
    lines.push(
      `${rd.padEnd(13)} 一致 ${LAGS.map((lag, k) => `${lag}ms ${((acc[k].same / Math.max(1, acc[k].counted)) * 100).toFixed(1).padStart(5)}%`).join("・")} | 手順 ${got === truth ? "同じ" : `頭から ${same}/${res.moves.length} 手`}・作り変え ${snaps}・${engine.decoder.status}${dropped ? `・捨てた ${dropped}` : ""} | 追跡 ${(ms / readings.length).toFixed(2)}ms/フレーム・観測 ${obs}・評価 ${(evals / Math.max(1, obs)).toFixed(0)}/観測`,
    );
  }
  lines.push(`合計          一致 ${LAGS.map((lag, k) => `${lag}ms ${((totals[k].same / Math.max(1, totals[k].counted)) * 100).toFixed(1).padStart(5)}%`).join("・")}`);
  lines.push(`平均（1 本ずつの 300ms の一致の平均） ${((meanSum / Math.max(1, sets.length)) * 100).toFixed(1)}%`);
  console.log(lines.join("\n"));
}, 3600000);

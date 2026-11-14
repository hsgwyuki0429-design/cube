// 書き出したライブの読み（realVideo.debug.test.ts の REAL_READINGS: 実物の動画でライブが処理したフレームの認識の結果）を、ライブの
// 追跡（観測器 + デコーダ + 作り変え）だけに通し直して、3D に出した状態が精密解析の状態（REAL_REF で書き出したもの）と同じだった時間の
// 割合を出す。認識は追跡の結果に依らないので、追跡だけを直して何度も測るときに速い（1 本 1 秒ほど）。
//   LIVE_SETS="4972-10:ref-4972.json,4970-10:ref-4970.json"（読みのファイル:精密解析の結果。LIVE_DIR からの相対）
//   LIVE_ENGINE='{"decoder":{"maxMovesPerStep":4}}'（本体のライブの設定に上書き）・LIVE_DUMP=1（観測ごと）
import { readFileSync } from "node:fs";
import { it } from "vitest";
import { ARUCO_REFS } from "../../src/aruco/palette";
import { MOVE_NAMES, VIEW, applyMove, inverseMove, statesEqual } from "../../src/cube/model";
import { type EngineOptions, TrackerEngine } from "../../src/track/engine";
import { simplifyMoves } from "../../src/track/merge";
import { ARUCO_OBSERVER, type FrameReading, LIVE_OBSERVER } from "../../src/track/observer";
import type { RefineResult } from "../../src/vision/refine";
import type { SightFrame } from "../../src/track/pieces/frame";
import { slotsPlausible } from "../../src/track/pieces/slotCheck";

const LAGS = [150, 300, 600];

export function liveEngineOptions(over: Partial<EngineOptions> = {}): Partial<EngineOptions> {
  // 本体のライブ（src/app/controller.ts の liveEngineOptions）
  return { ...over, observer: { ...ARUCO_OBSERVER, ...LIVE_OBSERVER, ...over.observer }, decoder: { priorWeight: 0, confirmMargin: 1, deepHyps: 4, bridgeDepth: 5, ...over.decoder }, snapToView: over.snapToView ?? true, recover: over.recover ?? true };
}

// 見えている 3 面（カメラの正面・上・右。姿勢 o）だけで比べる
const SEEN_SLOTS = [2, 0, 1];
function sameSeen(a: Uint8Array, b: Uint8Array, o: number): boolean {
  for (const slot of SEEN_SLOTS) for (let cell = 0; cell < 9; cell++) if (a[VIEW[(o * 6 + slot) * 9 + cell]] !== b[VIEW[(o * 6 + slot) * 9 + cell]]) return false;
  return true;
}
function matchesSeen(start: Uint8Array, res: RefineResult, t: number, lag: number, shown: Uint8Array, o: number): boolean {
  let st: Uint8Array = start;
  for (let j = 0; j <= res.moves.length; j++) {
    const began = j === 0 || res.moves[j - 1].start <= t;
    const still = j === res.moves.length || res.moves[j].end > t - lag;
    if (began && still && sameSeen(st, shown, o)) return true;
    if (!began) return false;
    if (j < res.moves.length) st = applyMove(st, res.moves[j].move);
  }
  return false;
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
  let seenSum = 0;
  const allRuns: number[] = [];
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
    let runStart: number | null = null;
    const runs: number[] = [];
    const kinds: Record<string, number> = {};
    const seenAcc = { same: 0, counted: 0 };
    for (let i = 0; i < readings.length; i++) {
      let r = readings[i];
      // スロットがありえないフレームの面を捨てる（本体と同じ: src/track/pieces/slotCheck.ts。LIVE_SLOTCHECK=0 で捨てない）
      const sight = (r as FrameReading & { sight?: SightFrame }).sight;
      if (process.env.LIVE_SLOTCHECK !== "0" && sight && r.faces.length && !slotsPlausible(sight)) {
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
      let shown: Uint8Array = Uint8Array.from(engine.view?.state ?? best.state);
      // LIVE_DELAY=ms: 表示を遅らせる（いまの一番合う仮説の手順で、delay ms 前の状態を出す。後の観測で確かめてから見せる）。
      // 比べるのも delay ms 前の本当の状態（遅れは別に delay ms 足される）
      const delay = Number(process.env.LIVE_DELAY ?? 0);
      if (delay && !engine.view) {
        const until = Math.max(r.t - delay, best.origin?.t ?? -Infinity);
        let st: Uint8Array = Uint8Array.from(best.state);
        for (let n = best.tail; n && n.t > until; n = n.prev) st = applyMove(st, inverseMove(n.move));
        shown = st;
      }
      const tEval = delay ? r.t - delay : r.t;
      if (process.env.LIVE_DUMP === "2" && !u) process.stdout.write(`${(r.t / 1000).toFixed(3)}   - ${r.faces.map((f) => `${f.slot}:${(f.ids ?? []).map((id, c) => (f.valid[c] && id >= 0 ? id : ".")).join(",")}`).join(" ")}\n`);
      if (process.env.LIVE_DUMP && u)
        process.stdout.write(
          `${(r.t / 1000).toFixed(3)} ${matches(st0, res, r.t, 300, shown) ? "=" : "≠"} ${engine.decoder.status} ${u.obsCost.toFixed(1)} ${engine.base?.n ?? 0}/${engine.view?.n ?? 0} ${r.faces.map((f) => `${f.slot}:${(f.ids ?? []).map((id, c) => (f.valid[c] && id >= 0 ? id : ".")).join(",")}`).join(" ")} | ${engine.decoder.bestMoves().slice(-10).map((m) => MOVE_NAMES[m.move]).join(" ")}\n`,
        );
      if (r.t < s0 || r.t > s1) continue;
      const dt = (readings[i + 1]?.t ?? r.t) - r.t;
      if (process.env.LIVE_KIND && !matches(st0, res, tEval, 300, shown)) {
        // 外れの種類: 2 秒前までの本当の状態と同じ（遅れ）・1 秒後までと同じ（先走り）・どれとも違う（違う状態）
        let kind = "wrong";
        let stK: Uint8Array = Uint8Array.from(st0);
        for (let j = 0; j <= res.moves.length; j++) {
          const from = j === 0 ? -Infinity : res.moves[j - 1].end;
          const to = j === res.moves.length ? Infinity : res.moves[j].start;
          if (statesEqual(stK, shown) && to > tEval - 2000 && from < tEval + 1000) {
            kind = from > tEval ? "early" : "late";
            break;
          }
          if (j < res.moves.length) stK = applyMove(stK, res.moves[j].move);
        }
        kinds[kind] = (kinds[kind] ?? 0) + dt;
      }
      seenAcc.counted += dt;
      if (matchesSeen(st0, res, tEval, 300, shown, engine.view?.orient ?? best.orient)) seenAcc.same += dt;
      LAGS.forEach((lag, k) => {
        acc[k].counted += dt;
        const ok = matches(st0, res, tEval, lag, shown);
        if (ok) acc[k].same += dt;
        // 見失っている区間（300ms の遅れを許しても違う）: 始まりから戻るまでの長さ
        if (k === 1) {
          if (!ok && runStart === null) runStart = r.t;
          if (ok && runStart !== null) {
            if (process.env.LIVE_RUNS && r.t - runStart >= 500) console.log(`RUN ${rd} ${(runStart / 1000).toFixed(2)}〜${(r.t / 1000).toFixed(2)}s`);
            runs.push(r.t - runStart);
            runStart = null;
          }
        }
      });
    }
    meanSum += acc[1].same / Math.max(1, acc[1].counted);
    seenSum += seenAcc.same / Math.max(1, seenAcc.counted);
    if (process.env.LIVE_SEEN) console.log(`SEEN ${rd} 全体 ${((acc[1].same / Math.max(1, acc[1].counted)) * 100).toFixed(1)}% 見えている 3 面 ${((seenAcc.same / Math.max(1, seenAcc.counted)) * 100).toFixed(1)}%`);
    if (process.env.LIVE_KIND) console.log(`KIND ${rd} 数えた ${(acc[1].counted / 1000).toFixed(1)}s ` + Object.entries(kinds).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`).join(" "));
    if (runStart !== null) runs.push(s1 - runStart);
    allRuns.push(...runs);
    const long = runs.filter((x) => x >= 500);
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
      `${rd.padEnd(13)} 一致 ${LAGS.map((lag, k) => `${lag}ms ${((acc[k].same / Math.max(1, acc[k].counted)) * 100).toFixed(1).padStart(5)}%`).join("・")} | 手順 ${got === truth ? "同じ" : `頭から ${same}/${res.moves.length} 手`}・見失い 0.5 秒以上 ${long.length} 回 計 ${(long.reduce((a, b) => a + b, 0) / 1000).toFixed(1)} 秒 最長 ${(Math.max(0, ...runs) / 1000).toFixed(1)} 秒・作り変え ${snaps}${engine.recoveries ? `・復帰 ${engine.recoveries}/${engine.recoverTries}（最大 ${engine.recoverMax.toFixed(0)}ms）` : ""}・${engine.decoder.status}${dropped ? `・捨てた ${dropped}` : ""} | 追跡 ${(ms / readings.length).toFixed(2)}ms/フレーム・観測 ${obs}・評価 ${(evals / Math.max(1, obs)).toFixed(0)}/観測`,
    );
  }
  lines.push(`合計          一致 ${LAGS.map((lag, k) => `${lag}ms ${((totals[k].same / Math.max(1, totals[k].counted)) * 100).toFixed(1).padStart(5)}%`).join("・")}`);
  {
    const long = allRuns.filter((x) => x >= 500).sort((a, b) => a - b);
    const sum = long.reduce((a, b) => a + b, 0);
    lines.push(`見失い（300ms の遅れを許しても違う区間）0.5 秒以上: ${long.length} 回・計 ${(sum / 1000).toFixed(1)} 秒・中央 ${((long[long.length >> 1] ?? 0) / 1000).toFixed(2)} 秒・長い方から 1 割 ${((long[Math.floor(long.length * 0.9)] ?? 0) / 1000).toFixed(1)} 秒・0.5 秒未満 ${allRuns.length - long.length} 回`);
  }
  lines.push(`見えている 3 面だけで比べた一致の平均 ${((seenSum / Math.max(1, sets.length)) * 100).toFixed(1)}%`);
  lines.push(`平均（1 本ずつの 300ms の一致の平均） ${((meanSum / Math.max(1, sets.length)) * 100).toFixed(1)}%`);
  console.log(lines.join("\n"));
}, 3600000);

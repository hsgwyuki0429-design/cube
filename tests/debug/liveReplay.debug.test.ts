// 書き出したライブの読み（realVideo.debug.test.ts の REAL_READINGS: 実物の動画でライブが処理したフレームの認識の結果）を、ライブの
// 追跡（観測器 + デコーダ + 作り変え）だけに通し直して、3D に出した状態が精密解析の状態（REAL_REF で書き出したもの）と同じだった時間の
// 割合を出す。認識は追跡の結果に依らないので、追跡だけを直して何度も測るときに速い（1 本 1 秒ほど）。
//   LIVE_SETS="4972-10:ref-4972.json,4970-10:ref-4970.json"（読みのファイル:精密解析の結果。LIVE_DIR からの相対）
//   LIVE_ENGINE='{"decoder":{"maxMovesPerStep":4}}'（本体のライブの設定に上書き）・LIVE_DUMP=1（観測ごと）
//   LIVE_ANIM=1: 3D の見せ方（src/ui/liveShow.ts）を、3D の手の待ち行列の模擬（tests/liveShowSim.ts）に通して、前（足された手を全部回す）と
//     後（層が動いたのをフレームで見た手だけ回す）で、回して見せた手の数・そのうち本当の手（精密解析の同じ面の手の回し始め 300ms 前〜
//     回し終わり 1 秒後）と結びつかない手（回していないのに回して見せた）・本当の手のうち回して見せた数・3D に出ていた状態（回している層は
//     回す前）が本当の状態と同じだった時間の割合（遅れ 300ms まで）を出す。LIVE_ANIM=2 で結びつかない手の時刻も
//   LIVE_MOVES=1: 追跡が数えた手（3D の見せ方とは別）。最後の一番合う仮説の手順（「数えた」）と、一度でも一番合う仮説の手順に出た手
//     （「出した」。手と時刻が同じものは 1 つ）を、回して見せた手と同じ決まりで本当の手に結びつける: ソルブの前（傾け・持ち替え）の手・
//     ソルブ中の結びつかない手・本当の手のうち結びついた数。LIVE_MOVES=2 で偽の手の時刻も。追跡の 1 フレームの時間の最大・99% も出す
import { readFileSync } from "node:fs";
import { it } from "vitest";
import { ARUCO_REFS } from "../../src/aruco/palette";
import { MOVE_NAMES, VIEW, applyMove, inverseMove, moveFace, statesEqual } from "../../src/cube/model";
import { type EngineOptions, TrackerEngine } from "../../src/track/engine";
import { simplifyMoves } from "../../src/track/merge";
import { ARUCO_OBSERVER, type FrameReading, LIVE_OBSERVER } from "../../src/track/observer";
import type { RefineResult } from "../../src/vision/refine";
import type { SightFrame } from "../../src/track/sight";
import { slotsPlausible } from "../../src/track/slotCheck";
import { LIVE_TRACKED_ORIENT, OrientTracker } from "../../src/track/orient";
import { LiveShow, seenMoves } from "../../src/ui/liveShow";
import { SimScene, type SimTurn } from "../liveShowSim";

const LAGS = [150, 300, 600];

export function liveEngineOptions(over: Partial<EngineOptions> = {}): Partial<EngineOptions> {
  // 本体のライブ（src/app/controller.ts の liveEngineOptions）
  // LIVE_OLD=1: 向きを別に追う前（2026-11-22 まで）
  const orient = process.env.LIVE_OLD ? {} : { orient: true, trackedOrient: LIVE_TRACKED_ORIENT };
  return { orient: orient.orient, ...over, observer: { ...ARUCO_OBSERVER, ...LIVE_OBSERVER, ...over.observer }, decoder: { priorWeight: 0, confirmMargin: 1, deepHyps: 4, bridgeDepth: 5, trackedOrient: orient.trackedOrient, ...over.decoder }, snapToView: over.snapToView ?? true, recover: over.recover ?? true };
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

// 回して見せた手を本当の手（精密解析の手）に結びつける: 同じ面で、本当の手の回し始め 300ms 前〜回し終わり 1 秒後に回し始めたもの。
// 本当の手 1 つに結びつけるのは 1 つだけ。返すのは結びつかなかった手と、回して見せた本当の手の数
function matchTurns(turns: SimTurn[], res: RefineResult, s0: number, s1: number, exact = false): { fake: SimTurn[]; real: number; truth: number } {
  const truth = res.moves.filter((m) => m.end >= s0 && m.start <= s1);
  const used = new Set<number>();
  const fake: SimTurn[] = [];
  for (const a of turns) {
    const j = truth.findIndex((m, k) => !used.has(k) && (exact ? m.move === a.move : moveFace(m.move) === moveFace(a.move)) && a.t >= m.start - 300 && a.t <= m.end + 1000);
    if (j >= 0) used.add(j);
    else fake.push(a);
  }
  return { fake, real: used.size, truth: truth.length };
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
  const animTotals: Record<string, { turns: number; fake: number; pre: number; real: number; truth: number; same: number; counted: number; mean: number }> = {};
  for (const k of ["前", "後"]) animTotals[k] = { turns: 0, fake: 0, pre: 0, real: 0, truth: 0, same: 0, counted: 0, mean: 0 };
  const moveTotals: Record<string, { pre: number; fake: number; real: number; truth: number; n: number }> = {};
  const allFrameMs: number[] = [];
  const orientMs: number[] = [];
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
    // LIVE_ANIM: 前（全部回す）・後（見た手だけ回す）の 3D
    const anim = !!process.env.LIVE_ANIM;
    const arrivals: { move: number; t: number; inferred: boolean; flags: string }[] = [];
    let lastLen = 0;
    const shows = (["前", "後"] as const).map((name) => ({ name, show: new LiveShow(), sim: new SimScene(st0), same: 0, counted: 0 }));
    // LIVE_MOVES: 一度でも一番合う仮説の手順に出た手（手と時刻が同じものは 1 つ）
    const everKey = new Set<string>();
    const ever: { move: number; t: number }[] = [];
    const frameMs: number[] = [];
    // 向きを追う部品だけの時間（同じフレームを別の OrientTracker に通す）
    const lone = new OrientTracker();
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
      if (process.env.LIVE_MOVES) {
        const b = performance.now();
        lone.push(r, sight);
        orientMs.push(performance.now() - b);
      }
      const a = performance.now();
      const u = engine.push(r, sight);
      const spent = performance.now() - a;
      ms += spent;
      frameMs.push(spent);
      if (u)
        for (const m of u.moves) {
          const key = `${m.move}@${Math.round(m.t)}`;
          if (everKey.has(key)) continue;
          everKey.add(key);
          ever.push({ move: m.move, t: m.t });
        }
      if (u) {
        obs++;
        evals += engine.decoder.lastExpanded;
      }
      if (anim && u) {
        // 足された手の、届いたときの印
        for (let j = lastLen; j < u.moves.length; j++) {
          const tm = u.timings[j];
          arrivals.push({ move: u.moves[j].move, t: u.moves[j].t, inferred: !!u.moves[j].inferred, flags: tm ? `${tm.exact ? "x" : "-"}${tm.endExact ? "e" : "-"}${tm.moved ? "m" : "-"}` : "null" });
        }
        lastLen = u.moves.length;
      }
      if (anim) {
        for (const a of shows) {
          a.sim.advance(r.t);
          if (u)
            a.show.apply(a.sim, {
              epoch: 1,
              setupMoves: [],
              moves: u.moves.map((m) => m.move),
              moveSeen: a.name === "前" ? u.moves.map(() => true) : seenMoves(u.moves, u.timings),
              base: u.base ?? { n: 0, at: 0, state: st0 },
              view: u.view,
            });
          a.sim.advance(r.t);
        }
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
          `${(r.t / 1000).toFixed(3)} ${matches(st0, res, r.t, 300, shown) ? "=" : "≠"} ${engine.decoder.status} ${u.obsCost.toFixed(1)} ${engine.base?.n ?? 0}/${engine.view?.n ?? 0}${engine.orient ? ` [${engine.lastOrient ? `s${engine.lastOrient.still.length}` : "-"}]` : ""} ${r.faces.map((f) => `${f.slot}:${(f.ids ?? []).map((id, c) => (f.valid[c] && id >= 0 ? id : ".")).join(",")}`).join(" ")} | ${engine.decoder.bestMoves().slice(-10).map((m) => MOVE_NAMES[m.move]).join(" ")}\n`,
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
      if (anim)
        for (const a of shows) {
          a.counted += dt;
          if (matches(st0, res, tEval, 300, a.sim.state)) a.same += dt;
        }
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
    if (anim) {
      const parts = shows.map((a) => {
        const turns = a.sim.log.filter((x) => !x.instant && x.t >= s0 && x.t <= s1);
        const m = matchTurns(turns, res, s0, s1);
        animTotals[a.name].turns += turns.length;
        animTotals[a.name].fake += m.fake.length;
        animTotals[a.name].real += m.real;
        animTotals[a.name].truth += m.truth;
        animTotals[a.name].same += a.same;
        animTotals[a.name].counted += a.counted;
        animTotals[a.name].mean += a.same / Math.max(1, a.counted);
        if (process.env.LIVE_ANIM === "3" && a.name === "後") {
          // 本当の手に結びついた「前」の手のうち、「後」で回さなかったもの: 届いたときと最後の時刻の印
          const fin = engine.decoder.bestMoves();
          const rows = fin.map((mv) => {
            const tm = engine.timing(mv);
            return `${MOVE_NAMES[mv.move]}@${(mv.t / 1000).toFixed(2)}${mv.inferred ? "?" : ""}[${tm ? `${tm.exact ? "x" : "-"}${tm.endExact ? "e" : "-"}${tm.moved ? "m" : "-"}` : "null"}]`;
          });
          console.log(`ANIMFIN ${rd} ${rows.join(" ")}`);
          console.log(`ANIMARR ${rd} ${arrivals.map((x) => `${MOVE_NAMES[x.move]}@${(x.t / 1000).toFixed(2)}${x.inferred ? "?" : ""}[${x.flags}]`).join(" ")}`);
        }
        const flagOf = (x: SimTurn) => {
          let best: (typeof arrivals)[number] | undefined;
          for (const y of arrivals) if (y.move === x.move && y.t <= x.t + 1) best = y;
          return best ? best.flags : "?";
        };
        if (process.env.LIVE_ANIM === "2" || process.env.LIVE_ANIM === "3")
          if (m.fake.length) console.log(`ANIMFAKE ${rd} ${a.name} ${m.fake.map((x) => `${(x.t / 1000).toFixed(2)}s ${MOVE_NAMES[x.move]}[${flagOf(x)}]`).join("・")}`);
        {
          // ソルブの前（インスペクション: 本当の手がない）に回して見せた手 = 持ち替え・傾けを手で説明したもの
          const pre = a.sim.log.filter((x) => !x.instant && x.t < s0 - 300);
          animTotals[a.name].pre += pre.length;
          if (process.env.LIVE_ANIM === "3" && pre.length) console.log(`ANIMPRE ${rd} ${a.name} ${pre.map((x) => `${(x.t / 1000).toFixed(2)}s ${MOVE_NAMES[x.move]}[${flagOf(x)}]`).join(" ")}`);
        }
        if (process.env.LIVE_ANIM === "3") {
          const fakeSet = new Set(m.fake);
          const tally: Record<string, [number, number]> = {};
          for (const x of turns) {
            const f = flagOf(x);
            tally[f] ??= [0, 0];
            tally[f][fakeSet.has(x) ? 1 : 0]++;
          }
          console.log(`ANIMFLAGS ${rd} ${a.name} ${Object.entries(tally).map(([k, [r, f]]) => `${k} 本当 ${r} 偽 ${f}`).join("・")}`);
        }
        return `${a.name} 回した ${turns.length}（結びつかない ${m.fake.length}）・本当の手 ${m.real}/${m.truth}・一致 ${((a.same / Math.max(1, a.counted)) * 100).toFixed(1)}%`;
      });
      console.log(`ANIM ${rd.padEnd(13)} ${parts.join(" | ")}`);
    }
    if (process.env.LIVE_MOVES) {
      // 数えた: 最後の手順（まとめる前）。正しく: 同じ面の手をまとめた形を、手そのものが同じ本当の手に結びつける。出した: 一度でも出した手。
      // 正しく以外は面が同じなら結びつける
      const raw = engine.decoder.bestMoves().map((m) => ({ move: m.move, t: m.t, instant: false }));
      const fin = simplifyMoves(engine.decoder.bestMoves()).map((m) => ({ move: m.move, t: m.t, instant: false }));
      const parts = [
        ["数えた", raw, false],
        ["正しく", fin, true],
        ["出した", ever.map((m) => ({ ...m, instant: false })), false],
      ] as const;
      const out = parts.map(([name, list, exact]) => {
        const pre = list.filter((x) => x.t < s0 - 300);
        const during = list.filter((x) => x.t >= s0 - 300 && x.t <= s1);
        const m = matchTurns(during, res, s0, s1, exact);
        const tot = (moveTotals[name] ??= { pre: 0, fake: 0, real: 0, truth: 0, n: 0 });
        tot.pre += pre.length;
        tot.fake += m.fake.length;
        tot.real += m.real;
        tot.truth += m.truth;
        tot.n += during.length;
        if (process.env.LIVE_MOVES === "2") {
          if (pre.length) console.log(`MOVEPRE ${rd} ${name} ${pre.map((x) => `${(x.t / 1000).toFixed(2)}s ${MOVE_NAMES[x.move]}`).join(" ")}`);
          if (m.fake.length) console.log(`MOVEFAKE ${rd} ${name} ${m.fake.map((x) => `${(x.t / 1000).toFixed(2)}s ${MOVE_NAMES[x.move]}`).join(" ")}`);
        }
        return `${name} 前 ${pre.length}・中 ${during.length}（結びつかない ${m.fake.length}）・本当の手 ${m.real}/${m.truth}`;
      });
      const sorted = [...frameMs].sort((x, y) => x - y);
      allFrameMs.push(...frameMs);
      console.log(`MOVES ${rd.padEnd(13)} ${out.join(" | ")} | 追跡 最大 ${sorted[sorted.length - 1]?.toFixed(1)}ms・99% ${sorted[Math.floor(sorted.length * 0.99)]?.toFixed(1)}ms`);
    }
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
      `${rd.padEnd(13)} 一致 ${LAGS.map((lag, k) => `${lag}ms ${((acc[k].same / Math.max(1, acc[k].counted)) * 100).toFixed(1).padStart(5)}%`).join("・")} | 手順 ${got === truth ? "同じ" : `頭から ${same}/${res.moves.length} 手`}・見失い 0.5 秒以上 ${long.length} 回 計 ${(long.reduce((a, b) => a + b, 0) / 1000).toFixed(1)} 秒 最長 ${(Math.max(0, ...runs) / 1000).toFixed(1)} 秒・作り変え ${snaps}${engine.recoveries ? `・復帰 ${engine.recoveries}/${engine.recoverTries}（最大 ${engine.recoverMax.toFixed(0)}ms）` : ""}・${engine.decoder.status}${dropped ? `・捨てた ${dropped}` : ""}${engine.orient ? `・向き 突き合わせ ${engine.orient.matched}/${engine.orient.faces}` : ""} | 追跡 ${(ms / readings.length).toFixed(2)}ms/フレーム・観測 ${obs}・評価 ${(evals / Math.max(1, obs)).toFixed(0)}/観測`,
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
  if (process.env.LIVE_ANIM)
    for (const [k, a] of Object.entries(animTotals))
      lines.push(
        `3D の見せ方 ${k}: ソルブの前に回した ${a.pre}・ソルブ中に回した ${a.turns}・うち結びつかない ${a.fake}（${((a.fake / Math.max(1, a.turns)) * 100).toFixed(1)}%）・本当の手を回した ${a.real}/${a.truth}（${((a.real / Math.max(1, a.truth)) * 100).toFixed(1)}%）・3D の一致 ${((a.same / Math.max(1, a.counted)) * 100).toFixed(1)}%（1 本ずつの平均 ${((a.mean / Math.max(1, sets.length)) * 100).toFixed(1)}%）`,
      );
  if (process.env.LIVE_MOVES) {
    for (const [k, a] of Object.entries(moveTotals))
      lines.push(`追跡の手 ${k}: ソルブの前 ${a.pre}・ソルブ中 ${a.n}・うち結びつかない ${a.fake}・本当の手 ${a.real}/${a.truth}（${((a.real / Math.max(1, a.truth)) * 100).toFixed(1)}%）`);
    const sorted = [...allFrameMs].sort((x, y) => x - y);
    const os = [...orientMs].sort((x, y) => x - y);
    lines.push(`向きを追う部品だけ: 平均 ${(orientMs.reduce((x, y) => x + y, 0) / Math.max(1, orientMs.length)).toFixed(3)}ms・99% ${os[Math.floor(os.length * 0.99)]?.toFixed(2)}ms・最大 ${os[os.length - 1]?.toFixed(2)}ms`);
    lines.push(`追跡の 1 フレーム: 平均 ${(allFrameMs.reduce((x, y) => x + y, 0) / Math.max(1, allFrameMs.length)).toFixed(2)}ms・99% ${sorted[Math.floor(sorted.length * 0.99)]?.toFixed(1)}ms・99.9% ${sorted[Math.floor(sorted.length * 0.999)]?.toFixed(1)}ms・最大 ${sorted[sorted.length - 1]?.toFixed(1)}ms・3ms を超えた ${((sorted.filter((x) => x > 3).length / Math.max(1, sorted.length)) * 100).toFixed(2)}%`);
  }
  console.log(lines.join("\n"));
}, 3600000);

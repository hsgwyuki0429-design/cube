// 実機の「ライブの記録」（設定画面の「ライブの記録を書き出す」: src/ui/liveLogExport.ts・src/track/liveLog.ts）を通し直す。
// 追跡は読みだけで決まるので、記録した読みを同じ設定の TrackerEngine に入れれば、実機と同じ結果になる（なるかを確かめる）。
// 直前のソルブ（精密解析の手順と時刻）があれば、ライブの 3D がそれと同じだった時間の割合も出す（liveReplay と同じ物差し）。
//   LIVE_LOG=ファイル（.json か .json.gz）・LIVE_LOG_ENGINE='{"decoder":{...}}'（設定を上書きして比べる）・LIVE_LOG_DUMP=1（観測ごと）
//   LIVE_LOG_PIECES='{}'（ソルブ中のライブの状態の推定を、本体と同じくタイマーの開始の判定で始めたと決めたフレームから使う。'{"agreeWait":true}'
//     など設定つき。記録した版が推定を使っていなければ、記録の「設定の変更」の pieces は無視する）。直前のソルブがあれば、3D の見せ方
//     （src/ui/liveShow.ts を模擬の 3D に通す）の回して見せた手・本当の手と結びつかない手・本当の手を回した数・3D の一致と、追跡が数えた手の
//     結びつかない数（liveReplay の LIVE_ANIM・LIVE_MOVES と同じ物差し）も出す。LIVE_LOG_TRUTH=ファイルで正解の手順を渡せる（下）。LIVE_LOG_PIECES=off で推定を使わない（記録の pieces を無視）
//   LIVE_LOG_REC=録画の書き出し（同じソルブの cubevision-rec-….mp4）: 正解をその精密解析の結果（始まりの状態・手の時刻はフレームの時間軸）にする
//     （記録の Solve.moves の時刻は精密解析の回し始めからで、timer.startT（ライブの開始）からではない）
//   版 2 の記録（src/track/liveLog.ts）は古い読みを捨てても区切りの始まり（resume）から通し直せる。版 1 の記録は LIVE_LOG_FROM=inspect で
//     「インスペクションの始まり（作り変えを始めた設定の変更）から、タイマーのスクランブルの状態」で通す（手の数は直前の実機の観測の数を足して比べる）
//   LIVE_LOG_TRIM=ミリ秒: 記録を一度通し直して、その長さだけ残す新しい記録（本体と同じ LiveLog）を作り、それを通し直す（捨てた後も実機と同じに
//     なるかの確かめ。本体は 120000）
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { it } from "vitest";
import { ARUCO_REFS } from "../../src/aruco/palette";
import { MOVE_NAMES, applyMove, applyMoves, parseMoves, solvedState, statesEqual } from "../../src/cube/model";
import { type EngineOptions, TrackerEngine } from "../../src/track/engine";
import { LiveLog, type LiveLogSegment, type LoggedReading, mergeOptions } from "../../src/track/liveLog";
import { loadExport } from "./lib/recording";
import { StartDetector } from "../../src/app/startDetect";
import { LiveShow, seenMoves } from "../../src/ui/liveShow";
import { SimScene } from "../liveShowSim";
import { matchTurns } from "./lib/turnMatch";
import type { RefineResult } from "../../src/vision/refine";
import { hypOf, liveFrame } from "../../src/track/liveState";
import { simplifyMoves } from "../../src/track/merge";
import { isSolved, moveFace } from "../../src/cube/model";

interface TruthMove {
  move: number;
  start: number;
  end: number;
}

// 3D の状態と、遅れ lag までの本当の状態のうちいちばん近いものの、違う facelet の数（センターは数えない）
function nearest(start: Uint8Array, moves: TruthMove[], t: number, lag: number, shown: Uint8Array): number {
  let st: Uint8Array = start;
  let best = 99;
  for (let j = 0; j <= moves.length; j++) {
    const began = j === 0 || moves[j - 1].start <= t;
    const still = j === moves.length || moves[j].end > t - lag;
    if (!began) break;
    if (still) {
      let d = 0;
      for (let k = 0; k < 54; k++) if (k % 9 !== 4 && st[k] !== shown[k]) d++;
      best = Math.min(best, d);
    }
    if (j < moves.length) st = applyMove(st, moves[j].move);
  }
  return best;
}

function matches(start: Uint8Array, moves: TruthMove[], t: number, lag: number, shown: Uint8Array): boolean {
  let st: Uint8Array = start;
  for (let j = 0; j <= moves.length; j++) {
    const began = j === 0 || moves[j - 1].start <= t;
    const still = j === moves.length || moves[j].end > t - lag;
    if (began && still && statesEqual(st, shown)) return true;
    if (!began) return false;
    if (j < moves.length) st = applyMove(st, moves[j].move);
  }
  return false;
}

// 3D の見せ方と追跡が数えた手（liveReplay の LIVE_ANIM・LIVE_MOVES と同じ: 回し始め 300ms 前〜回し終わり 1 秒後の同じ面の本当の手に結びつける）
function animLine(truth: { moves: TruthMove[]; from: number; to: number }, sim: SimScene, engine: TrackerEngine, anim: { same: number; counted: number }, switched: number): string {
  const res = { moves: truth.moves } as unknown as RefineResult;
  const s0 = truth.moves[0]?.start ?? truth.from;
  const s1 = (truth.moves[truth.moves.length - 1]?.end ?? truth.to) + 1000;
  const turns = sim.log.filter((x) => !x.instant && x.t >= s0 && x.t <= s1);
  const m = matchTurns(turns, res, s0, s1);
  const pre = sim.log.filter((x) => !x.instant && x.t < s0 - 300).length;
  const fin = (engine.live ? engine.live.moves() : engine.decoder.bestMoves()).map((x) => ({ move: x.move, t: x.t, instant: false }));
  const during = fin.filter((x) => x.t >= s0 - 300 && x.t <= s1);
  const mm = matchTurns(during, res, s0, s1);
  return `3D の見せ方: ソルブの前に回した ${pre}・ソルブ中に回した ${turns.length}（結びつかない ${m.fake.length}）・本当の手を回した ${m.real}/${m.truth}・3D の一致 ${((anim.same / Math.max(1, anim.counted)) * 100).toFixed(1)}% | 追跡が数えた手: ソルブ中 ${during.length}（結びつかない ${mm.fake.length}）・本当の手 ${mm.real}/${mm.truth}${switched >= 0 ? `・推定 ${((switched - truth.from) / 1000).toFixed(2)}s から` : ""}`;
}

// 正解がなくても出せるもの: 見え方との一致・最後に揃ったか・計測中に数えた手（まとめる前・後）・すぐ打ち消した手の組（偽の手の目安）・
// 3D で回して見せた手と塗り替えた手
function lookLine(from: number, sim: SimScene, engine: TrackerEngine, look: { same: number; counted: number }, switched: number): string {
  const moves = (engine.live ? engine.live.moves() : engine.decoder.bestMoves()).filter((m) => m.t >= from);
  let undo = 0;
  for (let k = 1; k < moves.length; k++) if (moveFace(moves[k].move) === moveFace(moves[k - 1].move) && moves[k].t - moves[k - 1].t < 500 && (moves[k].move % 3) + (moves[k - 1].move % 3) === 2) undo++;
  const turns = sim.log.filter((x) => x.t >= from);
  return `計測中（${(from / 1000).toFixed(2)}s から${switched >= 0 ? `・推定 ${((switched - from) / 1000).toFixed(2)}s から` : ""}）: 見え方と 3D が同じ ${((look.same / Math.max(1, look.counted)) * 100).toFixed(1)}%（${(look.counted / 1000).toFixed(1)} 秒）・最後の 3D ${isSolved(sim.state) ? "揃い" : "揃っていない"}・数えた手 ${moves.length}（まとめて ${simplifyMoves(moves).length}・すぐ打ち消した組 ${undo}）・3D で回した ${turns.filter((x) => !x.instant).length}・塗り替えた ${turns.filter((x) => x.instant).length}`;
}

const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : 0;
};

it("実機のライブの記録", () => {
  const path = process.env.LIVE_LOG;
  if (!path) return;
  const raw = readFileSync(path);
  const data = JSON.parse((path.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8"));
  const over = JSON.parse(process.env.LIVE_LOG_ENGINE ?? "{}") as Partial<EngineOptions>;
  console.log(`端末 ${data.device?.ua}\nコア ${data.device?.cores}・カメラ ${data.camera?.width}×${data.camera?.height} ${data.camera?.frameRate ?? "?"}fps・補助で認識 ${data.helperFrames}`);
  // 直前のソルブ: 計測開始（timer.startT）からの時刻の手を、フレームの時間軸に直す
  // 記録の solves は新しい順（timer の solves の先頭が直前のソルブ）
  const solve = [...(data.solves ?? [])].sort((a: { date: number }, b: { date: number }) => b.date - a.date)[0];
  let truth: { start: Uint8Array; moves: TruthMove[]; from: number; to: number } | null = null;
  // 直前のソルブの記録がこのソルブのものか（2026-11-27 より前の書き出しは古い方の 3 つを添えていた: そのときは正解なしで、見え方との一致だけ出す）
  const own = !!solve && (!Array.isArray(data.timer?.scramble) || statesEqual(applyMoves(solvedState(), parseMoves(solve.scramble)), applyMoves(solvedState(), data.timer.scramble)));
  if (solve && !own) console.log(`直前のソルブの記録がない（添えられたソルブはタイマーのスクランブルと違う）: 見え方との一致だけ出す。計測の始まり ${(data.timer.startT / 1000).toFixed(2)}s`);
  const solveFrom: number | null = data.timer?.startT ?? null;
  const scrambleState: Uint8Array | null = Array.isArray(data.timer?.scramble) && data.timer.scramble.length ? applyMoves(solvedState(), data.timer.scramble) : null;
  // LIVE_LOG_TRUTH=ファイル（{start, moves: [{move, start, end}]}）: 直前のソルブの記録がないとき、正解の代わりに使う手順（記録の読みを精密解析の
  // 解き直しに通したものなど）
  if (process.env.LIVE_LOG_REC) {
    const m = loadExport(process.env.LIVE_LOG_REC);
    const res = m?.analysis.result;
    if (!m || !res) throw new Error("LIVE_LOG_REC に精密解析の結果がない");
    const end = res.moves[res.moves.length - 1]?.end ?? data.timer.startT;
    truth = { start: Uint8Array.from(res.startState ?? m.analysis.input.state), moves: res.moves.map((x) => ({ move: x.move, start: x.start, end: x.end })), from: res.start ?? data.timer.startT, to: end + 1000 };
    console.log(`正解: 録画の精密解析 ${res.moves.length} 手・推定 ${res.moves.filter((x) => x.inferred).length}・${res.solved ? "完成" : "完成しない"}（${((end - (res.start ?? 0)) / 1000).toFixed(2)} 秒）`);
  } else if (!process.env.LIVE_LOG_TRUTH && data.analysis?.moves?.length && solve && own && data.analysis.solveId === solve.id) {
    // 書き出しに添えた直前のソルブの精密解析（2026-11-27 から）
    const a = data.analysis;
    const end = a.moves[a.moves.length - 1].end;
    truth = { start: Uint8Array.from(a.startState), moves: a.moves, from: a.start ?? data.timer.startT, to: end + 1000 };
    console.log(`正解: 書き出しに添えた精密解析 ${a.moves.length} 手・${a.solved ? "完成" : "完成しない"}`);
  } else if (process.env.LIVE_LOG_TRUTH) {
    const j = JSON.parse(readFileSync(process.env.LIVE_LOG_TRUTH, "utf8")) as { start: number[]; moves: TruthMove[] };
    const end = j.moves[j.moves.length - 1]?.end ?? data.timer.startT;
    truth = { start: Uint8Array.from(j.start), moves: j.moves, from: data.timer.startT, to: end + 1000 };
    console.log(`正解の代わり: ${process.env.LIVE_LOG_TRUTH}（${j.moves.length} 手）`);
  } else if (solve && own && data.timer?.startT) {
    // Solve.moves の時刻は記録の回し始め（精密解析で確定したら解析の最初の手の回し始め）から。timer.startT はライブの開始で、
    // 解析で確定した記録とは 0.1〜0.6 秒ずれる（2026-11-27 の 2 本）。正しい時刻は LIVE_LOG_REC か、書き出しに添えた analysis で
    const t0 = data.timer.startT;
    if (solve.analysis === "done" || solve.analysis === "partial") console.log("注意: 記録の手の時刻の基準が timer.startT とずれうる（LIVE_LOG_REC=同じソルブの録画の書き出し を渡すと正しい時刻になる）");
    const moves = solve.moves.map((m: { m: string; s?: number; t: number }) => ({ move: parseMoves(m.m)[0], start: t0 + (m.s ?? m.t), end: t0 + m.t }));
    // 始まりの状態: タイマーの scramble（手の番号。直前のソルブのもの）。記録の Solve.scramble は表記の向きの文字列で、キューブ固定の手と違うことがある
    const scramble: number[] = Array.isArray(data.timer.scramble) && data.timer.scramble.length ? data.timer.scramble : parseMoves(solve.scramble);
    truth = { start: applyMoves(solvedState(), scramble), moves, from: t0, to: t0 + solve.timeMs + 1000 };
    console.log(`直前のソルブ ${(solve.timeMs / 1000).toFixed(2)} 秒・${solve.moves.length} 手・解析 ${solve.analysis}`);
  }
  let segs = data.log.segments as LiveLogSegment[];
  console.log(`記録の版 ${data.log.version ?? 1}・区切り ${segs.length}${segs.some((s) => s.resume) ? `・途中から（${segs.filter((s) => s.resume).map((s) => `${(s.resume!.t / 1000).toFixed(2)}s`).join(" ")}）` : ""}${segs.some((s) => s.unknownStart) ? "・始まりの状態が分からない区切りあり" : ""}`);
  // 版 1 の記録: インスペクションの始まりから、タイマーのスクランブルの状態で
  const moveOffset = new Map<LiveLogSegment, { moves: number; base: number }>();
  if (process.env.LIVE_LOG_FROM === "inspect" && scrambleState && solveFrom !== null) {
    segs = segs.map((seg) => {
      let cut = -1;
      for (const e of seg.events) if (e.kind === "options" && e.t < solveFrom && (e.data as { snapToView?: boolean })?.snapToView === true) cut = e.t;
      if (cut < 0 || cut < seg.readings[0]?.t) return seg;
      let options: unknown = seg.options;
      for (const e of seg.events) if (e.t <= cut && e.kind === "options") options = mergeOptions(options, e.data);
      const before = seg.readings.filter((r) => r.t <= cut && r.out);
      const last = before[before.length - 1]?.out;
      const out: LiveLogSegment = { ...seg, start: Array.from(scrambleState), orients: undefined, options, events: seg.events.filter((e) => e.t > cut), readings: seg.readings.filter((r) => r.t > cut) };
      moveOffset.set(out, { moves: last?.moves ?? 0, base: last?.base ?? 0 });
      console.log(`インスペクションの始まり ${(cut / 1000).toFixed(2)}s から、スクランブルの状態で通す（その前の実機の手 ${last?.moves ?? 0}・作り変え ${last?.base ?? 0}）`);
      return out;
    });
  }
  // LIVE_LOG_TRIM: 本体と同じ LiveLog で記録し直して（短く残す）、それを通し直す
  if (process.env.LIVE_LOG_TRIM) {
    const keep = Number(process.env.LIVE_LOG_TRIM);
    const relog = new LiveLog(keep);
    for (const seg of segs) {
      const eng = new TrackerEngine(Uint8Array.from(seg.start), ARUCO_REFS, seg.options as Partial<EngineOptions>, seg.orients);
      relog.start(seg.start, seg.options, seg.orients);
      let ev = 0;
      for (const r of seg.readings) {
        while (ev < seg.events.length && seg.events[ev].t < r.t) {
          const e = seg.events[ev++];
          if (e.kind === "options") {
            eng.setOptions(e.data as Partial<EngineOptions>);
            relog.event("options", e.data);
          }
        }
        const u = eng.push(r.dropped ? { ...r, faces: [] } : r, r.sight);
        const { out: _o, ...rest } = r;
        relog.add({ ...rest, ...(u ? { out: { status: u.status, obsCost: u.obsCost, moves: u.moves.length, last: u.moves.slice(-4).map((m) => m.move), base: u.base?.n ?? 0, view: u.view?.n ?? 0 } } : {}) }, () => eng.checkpoint());
      }
    }
    segs = JSON.parse(JSON.stringify(relog.toJSON())).segments;
    console.log(`記録し直した（${keep}ms 残す）: 区切り ${segs.length}・${segs.map((s) => `${s.readings.length} 枚${s.resume ? `（${(s.resume.t / 1000).toFixed(2)}s から・手 ${s.resume.moves}）` : ""}${s.unknownStart ? "（始まりが分からない）" : ""}`).join("・")}`);
  }
  segs.forEach((seg, si) => {
    const rs = seg.readings as LoggedReading[];
    if (!rs.length) return;
    const off = seg.resume ? { moves: seg.resume.moves, base: -1 } : (moveOffset.get(seg) ?? { moves: 0, base: -1 });
    const opts = { ...(seg.options as Partial<EngineOptions>), ...over };
    // LIVE_LOG_PIECES=off: 推定を使わない（#113 の版。記録の pieces を無視する）
    const piecesOff = process.env.LIVE_LOG_PIECES === "off";
    const piecesOpt = process.env.LIVE_LOG_PIECES && !piecesOff ? JSON.parse(process.env.LIVE_LOG_PIECES) : null;
    const opts0 = { ...opts };
    if (piecesOff) delete opts0.pieces;
    const engine = new TrackerEngine(Uint8Array.from(seg.start), ARUCO_REFS, piecesOpt ? { ...opts0, pieces: false } : opts0, seg.orients);
    if (seg.resume) engine.resume({ ...seg.resume, state: seg.start, orients: seg.orients ?? [] });
    // ソルブ中のライブの状態の推定: インスペクション（スクランブルの状態）からタイマーの開始の判定で切り替える
    const starter = new StartDetector();
    const target = truth?.start ?? scrambleState;
    // 見え方との一致（正解がなくても出せる）: 計測の始まりからの、置き方の決まった面の読みが 4 つ以上あるフレームで、3D（模擬）の状態の
    // ピースの位置が読みと全部合う時間の割合
    const look = { same: 0, counted: 0 };
    let switched = -1;
    let inspecting = false;
    let ready = 0; // 追跡がスクランブルの状態に着いた（本体のインスペクション）
    // 3D の見せ方（模擬）と、追跡が数えた手
    const show = new LiveShow();
    const sim = new SimScene(Uint8Array.from(seg.start));
    let lastU: ReturnType<typeof engine.push> = null;
    const anim = { same: 0, counted: 0 };
    let ev = 0;
    let same = 0;
    let differ = 0;
    let firstDiff = "";
    let snaps = 0;
    let lastBase = 0;
    const acc = { same: 0, counted: 0 };
    let runStart: number | null = null;
    const runs: [number, number][] = [];
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i];
      while (ev < seg.events.length && seg.events[ev].t < r.t) {
        const e = seg.events[ev++];
        if (e.kind === "options" && !process.env.LIVE_LOG_ENGINE) {
          const o = { ...(e.data as Partial<EngineOptions>) };
          if (piecesOpt || piecesOff) delete o.pieces;
          engine.setOptions(o);
        }
      }
      if (piecesOpt && switched < 0 && target && inspecting) starter.frame(r.t, r.sight, target);
      const u = engine.push(r.dropped ? { ...r, faces: [] } : r, r.sight);
      if (piecesOpt && switched < 0 && u && target && !inspecting && statesEqual(Uint8Array.from(u.state), target)) {
        inspecting = true;
        ready = u.moves.length;
      }
      if (piecesOpt && switched < 0 && u && inspecting && starter.push(u, ready, r.t) !== null) {
        engine.setOptions({ pieces: piecesOpt });
        switched = r.t;
      }
      if (u) lastU = u;
      sim.advance(r.t);
      const uu = u ?? (show.held ? lastU : null);
      if (uu)
        show.apply(sim, {
          epoch: 1,
          setupMoves: [],
          moves: uu.moves.map((m) => m.move),
          moveSeen: seenMoves(uu.moves, uu.timings),
          ...(uu.agreed !== undefined ? { agreed: uu.agreed, now: r.t } : {}),
          base: uu.base ?? { n: 0, at: 0, state: seg.start },
          view: uu.view,
        });
      sim.advance(r.t);
      if (solveFrom !== null && r.t >= solveFrom && r.sight) {
        const fr = liveFrame(r.sight);
        const sure = fr.groups.filter((g) => g.mode === 0).reduce((n, g) => n + g.to - g.from, 0);
        if (sure >= 4) {
          const pos = hypOf(sim.state);
          let ok = true;
          for (const g of fr.groups) if (g.mode === 0) for (let j = g.from; j < g.to; j++) if (fr.ys[j * 4] >= 0 && pos[fr.piece[j]] !== 1 << fr.ys[j * 4]) ok = false;
          const dt = Math.min(100, (rs[i + 1]?.t ?? r.t) - r.t);
          look.counted += dt;
          if (ok) look.same += dt;
        }
      }
      if (engine.base && engine.base.n !== lastBase) snaps++;
      lastBase = engine.base?.n ?? 0;
      if (u && r.out) {
        // 途中から通したとき: 手の数は、その時点までの実機の手を足して比べる。最後の 4 手は通し直した分だけ比べる
        const ub = u.base?.n ?? 0;
        const tail = u.moves.slice(-4);
        const lastDev = r.out.last.slice(r.out.last.length - tail.length);
        const ok = u.moves.length + off.moves === r.out.moves && (ub === r.out.base || (off.base >= 0 && ub === 0 && r.out.base === off.base)) && tail.every((m, k) => m.move === lastDev[k]);
        if (ok) same++;
        else {
          differ++;
          if (!firstDiff) firstDiff = `${(r.t / 1000).toFixed(2)}s 実機 ${r.out.moves} 手 ${r.out.last.map((m) => MOVE_NAMES[m]).join(" ")} / 再生 ${u.moves.length + off.moves} 手 ${u.moves.slice(-4).map((m) => MOVE_NAMES[m.move]).join(" ")}`;
        }
      }
      if (process.env.LIVE_LOG_DUMP && u)
        console.log(`${(r.t / 1000).toFixed(3)} ${u.status} ${u.obsCost.toFixed(1)} ${u.base?.n ?? 0}/${u.view?.n ?? 0} ${r.faces.map((f) => `${f.slot}:${(f.ids ?? []).map((id, c) => (f.valid[c] && id >= 0 ? id : ".")).join(",")}`).join(" ")} | ${u.moves.slice(-8).map((m) => MOVE_NAMES[m.move]).join(" ")}`);
      if (truth && r.t >= truth.from && r.t <= truth.to) {
        const shown = Uint8Array.from(engine.live ? engine.live.display() : (engine.view?.state ?? engine.decoder.best().state));
        const dt = (rs[i + 1]?.t ?? r.t) - r.t;
        anim.counted += dt;
        if (matches(truth.start, truth.moves, r.t, 300, sim.state)) anim.same += dt;
        acc.counted += dt;
        const ok = matches(truth.start, truth.moves, r.t, 300, shown);
        if (ok) acc.same += dt;
        if (process.env.LIVE_LOG_DIFF && (i % 30 === 0)) console.log(`  ${((r.t - truth.from) / 1000).toFixed(2)}s 違う facelet ${nearest(truth.start, truth.moves, r.t, 300, shown)}`);
        if (!ok && runStart === null) runStart = r.t;
        if (ok && runStart !== null) {
          runs.push([runStart, r.t]);
          runStart = null;
        }
      }
    }
    const span = (rs[rs.length - 1].t - rs[0].t) / 1000;
    const withFaces = rs.filter((r) => r.faces.length).length;
    const ids = rs.map((r) => r.faces.reduce((n, f) => n + (f.ids ?? []).filter((id, c) => id >= 0 && f.valid[c]).length, 0));
    const skips = seg.events.filter((e) => e.kind === "skip").reduce((n, e) => n + (e.data as number), 0);
    const proc = rs.map((r) => r.procMs);
    const gaps = rs.slice(1).map((r, k) => r.t - rs[k].t);
    console.log(
      `区切り ${si}: ${span.toFixed(1)} 秒・処理 ${rs.length} 枚（1 秒 ${(rs.length / Math.max(0.001, span)).toFixed(1)} 枚・捨てた ${skips} 枚・補助 ${rs.filter((r) => r.helper).length}）` +
        `・フレームの間 中央 ${pct(gaps, 0.5).toFixed(0)}ms 90% ${pct(gaps, 0.9).toFixed(0)}ms 最大 ${pct(gaps, 1).toFixed(0)}ms` +
        `\n  認識 中央 ${pct(proc, 0.5).toFixed(1)}ms 90% ${pct(proc, 0.9).toFixed(1)}ms・面が読めた ${((withFaces / rs.length) * 100).toFixed(0)}%・ID が読めたマス 平均 ${(ids.reduce((a, b) => a + b, 0) / rs.length).toFixed(1)}・スロットで捨てた ${rs.filter((r) => r.dropped).length}` +
        `\n  再生: 実機と同じ ${same}・違う ${differ}${firstDiff ? `（最初 ${firstDiff}）` : ""}・作り変え ${snaps}・最後 ${engine.decoder.status}` +
        (truth && acc.counted ? `\n  ${animLine(truth, sim, engine, anim, switched)}` : "") +
        (solveFrom !== null ? `\n  ${lookLine(solveFrom, sim, engine, look, switched)}` : "") +
        (truth && acc.counted ? `\n  ソルブの間 3D が精密解析と同じ ${((acc.same / acc.counted) * 100).toFixed(1)}%（遅れ 300ms まで）・0.5 秒以上の外れ ${runs.filter(([a, b]) => b - a >= 500).map(([a, b]) => `${((a - truth!.from) / 1000).toFixed(1)}〜${((b - truth!.from) / 1000).toFixed(1)}s`).join(" ")}` : ""),
    );
  });
}, 600000);

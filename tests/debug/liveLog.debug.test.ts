// 実機の「ライブの記録」（設定画面の「ライブの記録を書き出す」: src/ui/liveLogExport.ts・src/track/liveLog.ts）を通し直す。
// 追跡は読みだけで決まるので、記録した読みを同じ設定の TrackerEngine に入れれば、実機と同じ結果になる（なるかを確かめる）。
// 直前のソルブ（精密解析の手順と時刻）があれば、ライブの 3D がそれと同じだった時間の割合も出す（liveReplay と同じ物差し）。
//   LIVE_LOG=ファイル（.json か .json.gz）・LIVE_LOG_ENGINE='{"decoder":{...}}'（設定を上書きして比べる）・LIVE_LOG_DUMP=1（観測ごと）
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { it } from "vitest";
import { ARUCO_REFS } from "../../src/aruco/palette";
import { MOVE_NAMES, applyMove, applyMoves, parseMoves, solvedState, statesEqual } from "../../src/cube/model";
import { type EngineOptions, TrackerEngine } from "../../src/track/engine";
import type { LiveLogSegment, LoggedReading } from "../../src/track/liveLog";

interface TruthMove {
  move: number;
  start: number;
  end: number;
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
  const solve = data.solves?.[data.solves.length - 1];
  let truth: { start: Uint8Array; moves: TruthMove[]; from: number; to: number } | null = null;
  if (solve && data.timer?.startT) {
    const t0 = data.timer.startT;
    const moves = solve.moves.map((m: { m: string; s?: number; t: number }) => ({ move: parseMoves(m.m)[0], start: t0 + (m.s ?? m.t), end: t0 + m.t }));
    truth = { start: applyMoves(solvedState(), parseMoves(solve.scramble)), moves, from: t0, to: t0 + solve.timeMs + 1000 };
    console.log(`直前のソルブ ${(solve.timeMs / 1000).toFixed(2)} 秒・${solve.moves.length} 手・解析 ${solve.analysis}`);
  }
  const segs = data.log.segments as LiveLogSegment[];
  segs.forEach((seg, si) => {
    const rs = seg.readings as LoggedReading[];
    if (!rs.length) return;
    const opts = { ...(seg.options as Partial<EngineOptions>), ...over };
    const engine = new TrackerEngine(Uint8Array.from(seg.start), ARUCO_REFS, opts, seg.orients);
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
        if (e.kind === "options" && !process.env.LIVE_LOG_ENGINE) engine.setOptions(e.data as Partial<EngineOptions>);
      }
      const u = engine.push(r.dropped ? { ...r, faces: [] } : r);
      if (engine.base && engine.base.n !== lastBase) snaps++;
      lastBase = engine.base?.n ?? 0;
      if (u && r.out) {
        const ok = u.moves.length === r.out.moves && (u.base?.n ?? 0) === r.out.base && u.moves.slice(-4).every((m, k) => m.move === r.out!.last[k]);
        if (ok) same++;
        else {
          differ++;
          if (!firstDiff) firstDiff = `${(r.t / 1000).toFixed(2)}s 実機 ${r.out.moves} 手 ${r.out.last.map((m) => MOVE_NAMES[m]).join(" ")} / 再生 ${u.moves.length} 手 ${u.moves.slice(-4).map((m) => MOVE_NAMES[m.move]).join(" ")}`;
        }
      }
      if (process.env.LIVE_LOG_DUMP && u)
        console.log(`${(r.t / 1000).toFixed(3)} ${u.status} ${u.obsCost.toFixed(1)} ${u.base?.n ?? 0}/${u.view?.n ?? 0} ${r.faces.map((f) => `${f.slot}:${(f.ids ?? []).map((id, c) => (f.valid[c] && id >= 0 ? id : ".")).join(",")}`).join(" ")} | ${u.moves.slice(-8).map((m) => MOVE_NAMES[m.move]).join(" ")}`);
      if (truth && r.t >= truth.from && r.t <= truth.to) {
        const shown = Uint8Array.from(engine.view?.state ?? engine.decoder.best().state);
        const dt = (rs[i + 1]?.t ?? r.t) - r.t;
        acc.counted += dt;
        const ok = matches(truth.start, truth.moves, r.t, 300, shown);
        if (ok) acc.same += dt;
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
        (truth && acc.counted ? `\n  ソルブの間 3D が精密解析と同じ ${((acc.same / acc.counted) * 100).toFixed(1)}%（遅れ 300ms まで）・0.5 秒以上の外れ ${runs.filter(([a, b]) => b - a >= 500).map(([a, b]) => `${((a - truth!.from) / 1000).toFixed(1)}〜${((b - truth!.from) / 1000).toFixed(1)}s`).join(" ")}` : ""),
    );
  });
}, 600000);

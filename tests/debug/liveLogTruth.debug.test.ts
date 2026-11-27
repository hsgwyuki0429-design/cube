// 実機のライブの記録（liveLog）に直前のソルブの解析がないとき（2026-11-27 より前の書き出しは古いソルブを添えていた）、記録の読みを精密解析の
// 2 つの解き直し（今の方式 decodeOffline・ピース方式 solvePieces）に通して、正解の代わりの手順を作る。両方の答え（まとめた形）が同じかを出す。
//   LIVE_LOG=ファイル LIVE_LOG_TRUTH_OUT=ref.json npx vitest run -c vitest.debug.config.ts tests/debug/liveLogTruth.debug.test.ts --silent=false
//   → liveLog の LIVE_LOG_TRUTH=ref.json（今の方式の答え。時刻つき）。始まりはタイマーのスクランブル、終わりは揃った状態、範囲は計測の 2 秒前から
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { it } from "vitest";
import { ARUCO_REFS } from "../../src/aruco/palette";
import { MOVE_NAMES, applyMoves, solvedState } from "../../src/cube/model";
import { TrackerEngine } from "../../src/track/engine";
import { ARUCO_OBSERVER } from "../../src/track/observer";
import { DEFAULT_OFFLINE, decodeOffline } from "../../src/track/offline";
import { buildTable } from "../../src/track/pieces/table";
import { solvePieces } from "../../src/track/pieces/solve";
import { simplifyMoves } from "../../src/track/merge";
it("ライブの記録から正解の代わりの手順", () => {
  const path = process.env.LIVE_LOG;
  if (!path) return;
  const raw = readFileSync(path);
  const d = JSON.parse((path.endsWith(".gz") ? gunzipSync(raw) : raw).toString());
  const seg = d.log.segments[0];
  const from = d.timer.startT - 2000;
  const start = applyMoves(solvedState(), d.timer.scramble);
  const rs = seg.readings.filter((r: { t: number }) => r.t >= from);
  const sights = rs.filter((r: { sight?: unknown }) => r.sight).map((r: { sight: unknown }) => r.sight);
  const p = solvePieces(buildTable(sights), start, solvedState(), { budgetMs: 60000 });
  console.log("pieces", p.reachedEnd, p.method, p.moves.length, "inferred", p.moves.filter((m) => m.inferred).length);
  const e = new TrackerEngine(start, ARUCO_REFS, { observer: ARUCO_OBSERVER, keepObservations: true, decoder: { beamWidth: 32, maxMovesPerStep: 3, rotationCost: 1.5 } });
  let last = 0;
  for (const r of rs) {
    e.push(r.dropped ? { ...r, faces: [] } : r, r.sight);
    last = r.t;
  }
  const o = decodeOffline(e.observationLog, start, solvedState(), last, DEFAULT_OFFLINE);
  console.log("old", o.reachedEnd, o.method, o.moves.length, "inferred", o.moves.filter((m) => m.inferred).length);
  const a = simplifyMoves(p.moves.map((m) => ({ move: m.move, t: m.t, t0: m.t0, orient: 0 }))).map((m) => MOVE_NAMES[m.move]);
  const b = simplifyMoves(o.moves).map((m) => MOVE_NAMES[m.move]);
  console.log("P", a.join(" "));
  console.log("O", b.join(" "));
  console.log(a.join(" ") === b.join(" ") ? "2 つの答えは同じ" : "2 つの答えが違う");
  if (process.env.LIVE_LOG_TRUTH_OUT) writeFileSync(process.env.LIVE_LOG_TRUTH_OUT, JSON.stringify({ start: Array.from(start), moves: simplifyMoves(o.moves).map((m) => ({ move: m.move, start: m.t0 ?? m.t, end: m.t, inferred: !!m.inferred })) }));
}, 600000);

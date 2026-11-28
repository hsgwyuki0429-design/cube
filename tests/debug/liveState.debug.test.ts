// ソルブ中のライブの状態の推定（src/track/liveState.ts）を、書き出したライブの読み（realVideo の REAL_READINGS）にフレームごとに通して、
// 読みの式・仮説の数・一番よい仮説・本当の状態（精密解析の手順と時刻: REAL_REF）が仮説に残っているかを出す（調査用）。
//   LS_DIR=~/rv LS_SET=read-4970-full.json:ref-4970.json LS_FROM=2.0 LS_TO=3.5 LS_OPTS='{"rate":4}'
//   npx vitest run -c vitest.debug.config.ts tests/debug/liveState.debug.test.ts --silent=false
// 始まりは LS_FROM の時点の本当の状態（その時刻までに回し終えた手）。LS_ENGINE=1 なら liveReplay と同じく、本体のライブの追跡で始め、
// タイマーの開始の判定で推定に切り替える（LS_FROM は表示の始まり）。行の印: = 一番よい仮説が本当の状態・~ 仮説のどれかが本当の状態・
// ≠ どれでもない（本当の状態は、回し始めた手を回し終えたとみなしてもよい）
import { readFileSync } from "node:fs";
import { it } from "vitest";
import { MOVE_NAMES, applyMove, statesEqual } from "../../src/cube/model";
import { LiveState, hypOf, liveFrame } from "../../src/track/liveState";
import { TrackerEngine } from "../../src/track/engine";
import { ARUCO_REFS } from "../../src/aruco/palette";
import { StartDetector } from "../../src/app/startDetect";
import { slotsPlausible } from "../../src/track/slotCheck";
import { liveEngineOptions } from "./liveReplay.debug.test";
import type { FrameReading } from "../../src/track/observer";
import type { SightFrame } from "../../src/track/sight";
import type { RefineResult } from "../../src/vision/refine";

it("ライブの状態の推定（フレームごと）", () => {
  const dir = (process.env.LS_DIR ?? `${process.env.HOME}/rv`).replace(/^~/, process.env.HOME ?? "");
  const [rd, rf] = (process.env.LS_SET ?? "read-4970-full.json:ref-4970.json").split(":");
  const { start, readings } = JSON.parse(readFileSync(`${dir}/${rd}`, "utf8")) as { start: number[]; readings: (FrameReading & { sight?: SightFrame })[] };
  const res = JSON.parse(readFileSync(`${dir}/${rf}`, "utf8")) as RefineResult;
  const from = Number(process.env.LS_FROM ?? 0) * 1000;
  const to = Number(process.env.LS_TO ?? 1e9) * 1000;
  const opts = JSON.parse(process.env.LS_OPTS ?? "{}");
  // 時刻 t の本当の状態の候補（回し始めた手は回し終えたとみなしてもよい）
  const truthAt = (t: number): Uint8Array[] => {
    let st: Uint8Array = Uint8Array.from(start);
    const out: Uint8Array[] = [];
    for (let j = 0; j <= res.moves.length; j++) {
      const began = j === 0 || res.moves[j - 1].start <= t;
      const still = j === res.moves.length || res.moves[j].end > t - 150;
      if (began && still) out.push(st);
      if (!began) break;
      if (j < res.moves.length) st = applyMove(st, res.moves[j].move);
    }
    return out;
  };
  const t0 = truthAt(from);
  const st0 = t0[t0.length - 1];
  const useEngine = !!process.env.LS_ENGINE;
  let live = new LiveState(st0, 0, from, [], null, opts);
  const engine = useEngine ? new TrackerEngine(Uint8Array.from(start), ARUCO_REFS, { ...liveEngineOptions(), pieces: false }) : null;
  const starter = new StartDetector();
  let lost = 0;
  let total = 0;
  let lastRel = 0;
  for (const r of readings) {
    if (engine && !engine.live) {
      const dropped = !!r.sight && r.faces.length > 0 && !slotsPlausible(r.sight);
      starter.frame(r.t, r.sight, Uint8Array.from(start));
      const u = engine.push(dropped ? { ...r, faces: [] } : r, r.sight);
      if (u && starter.push(u, 0, r.t) !== null) {
        engine.setOptions({ pieces: opts });
        live = engine.live!;
        console.log(`${(r.t / 1000).toFixed(3)} 推定に切り替え: ${live.moves().map((m) => MOVE_NAMES[m.move]).join(" ")}`);
      }
      continue;
    }
    if (r.t > to || !r.sight?.faces.length) continue;
    if (!engine && r.t < from) continue;
    // 読みの表示用（記憶は推定の中のものを写す）
    const fr = liveFrame(r.sight, { faces: live.memory.faces.slice() }, live.options);
    const wrongOf = () => {
      const tm = truthAt(r.t).map((st) => hypOf(st));
      const b0 = live.best();
      return tm.map((c) => Array.from(c).map((x, p) => (b0.mask[p] === x ? "" : `${p}${(b0.mask[p] & (b0.mask[p] - 1)) === 0 ? "" : "?"}${b0.mask[p] & x ? "∋" : ""}`)).filter(Boolean).join(",")).join(" / ");
    };
    const before = process.env.LS_SHOW ? wrongOf() : "";
    const a = performance.now();
    const stepped = engine ? !!engine.push(r, r.sight) : live.pushSight(r.sight);
    const ms = performance.now() - a;
    if (!stepped || r.t < from) continue;
    const truth = truthAt(r.t);
    const hit = live.hyps.findIndex((h) => live.known(h) && truth.some((s) => statesEqual(s, live.stateOf(h))));
    total++;
    if (hit < 0) lost++;
    const rel = (live.stats as { relocated?: number }).relocated ?? 0;
    const relMark = rel !== lastRel ? `R${rel}[${before} → ${wrongOf()}]` : "";
    lastRel = rel;
    const mark = relMark + (hit === 0 ? "=" : hit > 0 ? "~" : "≠") + (process.env.LS_SHOW ? (truth.some((st) => statesEqual(st, live.display())) ? "D" : "d") : "");
    const b = live.best();
    const top = live.hyps
      .slice(0, 3)
      .map((h) => `${h.cost.toFixed(1)}/${h.last.toFixed(1)}:${live.moves(h).slice(-4).map((m) => MOVE_NAMES[m.move]).join(" ")}`)
      .join(" | ");
    const truthMoves = res.moves.filter((m) => m.start <= r.t).slice(-3).map((m) => MOVE_NAMES[m.move]).join(" ");
    const reads = fr.groups.map((g) => `${"scn"[g.mode]}${"URFDLB"[g.face]}[${Array.from({ length: g.to - g.from }, (_, q) => `${fr.piece[g.from + q]}${g.mode === 0 ? `@${fr.ys[(g.from + q) * 4]}` : ""}`).join(" ")}]`).join(" ");
    console.log(`${(r.t / 1000).toFixed(3)} ${mark}${hit > 0 ? hit : ""} ${ms.toFixed(1)}ms 読み ${fr.n}（${fr.pieces}）中 ${fr.centers.map((c) => `${"URFDLB"[c.f]}${c.phi}`).join("")} o${fr.orient} 仮説 ${live.hyps.length}${live.known(b) ? "" : "（まとめ）"} | ${top} || 本当 ${truthMoves}${process.env.LS_READS ? ` || ${reads}` : ""}`);
  }
  console.log(`本当の状態が仮説にない 観測 ${lost}/${total}・深く ${live.stats.deep}・復帰 ${live.stats.recovered}/${live.stats.recoverTries}・見失い ${live.stats.lost}・まとめた ${live.stats.merged}・仮説 最大 ${live.stats.maxHyps}`);
}, 600000);

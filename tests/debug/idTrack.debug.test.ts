// ID なし追跡（src/aruco/idTrack.ts）の効果: 30fps で 8 手回す間、指（持ち方どおり + 横切る指）が動いてマーカーを隠す。
// 追跡なし・ありで、見えている 3 面のマスのうち ID が正しく分かったマス・誤ったマスと、ライブの追跡の手順を比べる。
//   npx vitest run -c vitest.debug.config.ts tests/debug/idTrack.debug.test.ts --silent=false
//   SEEDS=場面の数（既定 4）
import { it } from "vitest";
import { ARUCO_REFS } from "../../src/aruco/palette";
import { MOVE_NAMES, VIEW, type Vec3, parseMoves, solvedState } from "../../src/cube/model";
import { TrackerEngine } from "../../src/track/engine";
import { simplifyMoves } from "../../src/track/merge";
import { ARUCO_OBSERVER } from "../../src/track/observer";
import { applyH } from "../../src/vision/homography";
import { DEFAULT_PIPELINE, processFrame } from "../../src/vision/pipeline";
import { applyMoveStickers, renderArucoCube, solvedStickers, stickerAt } from "../arucoCube";
import type { Finger } from "../render";
import { loadTestOpenCv } from "../cv";

it("ID なし追跡の効果（30fps・指）", async () => {
  const cv = await loadTestOpenCv();
  const SIZE = { width: 960, height: 720 };
  const EYE: Vec3 = [2.4, 2.4, 5.5];
  const alg = "R U R' U' F2 D L' B";
  const truth = parseMoves(alg);
  const seeds = Number(process.env.SEEDS ?? 4);
  for (const idTrack of [false, true]) {
    const tally = { correct: 0, wrong: 0, cells: 0, ok: 0 };
    for (let seed = 1; seed <= seeds; seed++) {
      let s = seed * 7919;
      const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
      const pipeline = { ...DEFAULT_PIPELINE, stickers: "unique54" as const, arucoIdTrack: idTrack };
      const engine = new TrackerEngine(solvedState(), ARUCO_REFS, { observer: ARUCO_OBSERVER });
      const memory = {};
      let st = solvedStickers();
      let done = 0;
      const period = 400;
      const turnMs = 170;
      const lead = 300;
      // 正面の格子（指の位置を決めるため）
      const clean = processFrame(cv, renderArucoCube(cv, { ...SIZE, stickers: st, orient: 0, eye: EYE, noise: 2, scheme: "unique54" }), 0, { ...pipeline, arucoIdTrack: false }, {});
      const H = clean.faces.find((f) => f.slot === 2)!.H;
      const pitch = Math.hypot(applyH(H, 1, 0)[0] - applyH(H, 0, 0)[0], applyH(H, 1, 0)[1] - applyH(H, 0, 0)[1]);
      // 親指 2 本（ゆっくり動く）と、ときどき横切る指
      const phase = [rnd() * 6, rnd() * 6, rnd() * 6];
      for (let t = 0; t <= lead + truth.length * period + 400; t += 1000 / 30) {
        while (done < truth.length && t >= lead + done * period + turnMs) st = applyMoveStickers(st, truth[done++]);
        const start = lead + done * period;
        const turning = done < truth.length && t >= start;
        const thumb = (x: number, ph: number): Finger => {
          const tip = applyH(H, x + 0.5 * Math.sin(t / 400 + ph), 2.3 + 0.4 * Math.sin(t / 300 + ph));
          return { a: [tip[0], tip[1] + pitch * 3.5], b: tip, width: pitch * 0.85 };
        };
        const fingers: Finger[] = [thumb(0.4, phase[0]), thumb(2.6, phase[1])];
        if (Math.sin(t / 700 + phase[2]) > 0.3) {
          const tip = applyH(H, 1.5 + 1.2 * Math.sin(t / 250), 1.2);
          fingers.push({ a: [tip[0] + pitch * 3, tip[1] - pitch * 2], b: tip, width: pitch * 0.8 });
        }
        const img = renderArucoCube(cv, {
          ...SIZE,
          stickers: st,
          orient: 0,
          eye: [EYE[0] + 0.1 * Math.sin(t / 300), EYE[1], EYE[2]],
          turn: turning ? { move: truth[done], fraction: (t - start) / turnMs, spread: 0.15 } : undefined,
          noise: 2,
          seed: Math.round(t) + seed * 1000,
          scheme: "unique54",
          fingers,
        });
        const r = processFrame(cv, img, t, pipeline, memory);
        engine.push({ t, faces: r.faces.map((f) => ({ slot: f.slot, labs: f.labs, valid: f.valid, weight: f.weight, spread: f.spread, masked: f.masked, ids: f.ids })), turn: r.turn });
        if (turning) continue;
        const at = stickerAt(st);
        for (const f of r.faces) {
          if (f.ids?.[4] !== undefined && f.ids[4] >= 0 && f.ids[4] !== at[VIEW[f.slot * 9 + 4]]) continue; // 面の割り当てが違うフレーム
          tally.cells += 9;
          f.ids?.forEach((id, cell) => {
            if (id < 0) return;
            if (id === at[VIEW[f.slot * 9 + cell]]) tally.correct++;
            else tally.wrong++;
          });
        }
      }
      const live = simplifyMoves(engine.decoder.bestMoves()).map((m) => MOVE_NAMES[m.move]).join(" ");
      if (live === alg) tally.ok++;
      else console.log(`  seed ${seed} 追跡${idTrack ? "あり" : "なし"}: ${live}`);
    }
    console.log(`ID なし追跡 ${idTrack ? "あり" : "なし"}: ID が正しいマス ${((tally.correct / tally.cells) * 100).toFixed(1)}%・誤り ${tally.wrong}（${tally.cells} マス）・ライブの手順が正しい ${tally.ok}/${seeds}`);
  }
}, 7200000);

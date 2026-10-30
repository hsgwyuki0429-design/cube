// ステッカーの中のマーカーの配置（大きさ・個数・暗いマスの色。src/aruco/design.ts）の比較。
// 合成キューブ（54 種類・3×3 の符号）に指を描き、見えているマスごとに「何割隠れたか」と「そのマスの ID が読めたか」を数える。
// 同じ場面（状態・向き・視点・指・ぶれ）をすべての案で描いて比べる。
//   npx vitest run -c vitest.debug.config.ts tests/debug/stickerDesign.debug.test.ts
//   N=場面の数（距離ごと、既定 24）・DESIGNS=standard,half（key で絞る）・SAVE=1（案ごとの見本の画像も）・OUT=出力先（既定 e2e-output/sticker-design）
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { it } from "vitest";
import { DESIGNS, designLook } from "../../src/aruco/design";
import { ArucoBench, DEFAULT_CONFIGS } from "../../src/aruco/detect";
import { initOpenCv } from "../../src/vision/image";
import { renderArucoCube } from "../arucoCube";
import { H, PITCHES, SHAKES, W, inPoly, makeScenes } from "../arucoScenes";
import { writePng } from "./png";

const BINS = [0, 0.25, 0.5, 0.75, 1.0001]; // 隠れた割合: 0 / 〜25% / 〜50% / 〜75% / それ以上

interface Tally {
  n: number;
  ok: number;
}
const tally = (): Tally => ({ n: 0, ok: 0 });
const pct = (t: Tally) => (t.n ? `${((t.ok / t.n) * 100).toFixed(1)}%` : "-");

it("ステッカーの中のマーカーの配置の比較", async () => {
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const bench = new ArucoBench(cv, [DEFAULT_CONFIGS[1]], "unique54");
  const perPitch = Number(process.env.N ?? 24);
  const only = process.env.DESIGNS?.split(",");
  const designs = DESIGNS.filter((d) => !only || only.includes(d.key));
  const scenes = makeScenes(perPitch);
  const outDir = process.env.OUT ?? "e2e-output/sticker-design";
  mkdirSync(outDir, { recursive: true });
  const results: Record<string, unknown>[] = [];
  for (const design of designs) {
    const t0 = performance.now();
    const all = tally();
    const clear = tally(); // 指に隠れていないマス
    const bins = BINS.map(() => tally());
    const staticBins = BINS.map(() => tally()); // ぶれなし（shake 0）のときだけ
    const staticPitch = PITCHES.map(() => tally());
    const byPitch = PITCHES.map(() => tally());
    const byShake = SHAKES.map(() => tally());
    const byPattern: Record<string, Tally> = { none: tally(), grip: tally(), random: tally() };
    const oblique = tally(); // 向き 0.25〜0.5 の斜めの面（隠れていない）
    let wrong = 0;
    let wrongSameColor = 0; // 同じ色の別の ID（色の照合で見抜けない誤読）
    let cellWrong = 0; // マスの中の多数決（4 個の配置）でも別の ID になったマス
    let outside = 0;
    let copies = 0;
    let identified = 0;
    let frameMs = 0;
    scenes.forEach((sc, si) => {
      const img = renderArucoCube(cv, { width: W, height: H, stickers: sc.st, orient: sc.orient, eye: sc.eye, noise: 2.5, seed: si + 1, scheme: "unique54", design, fingers: sc.fingers, shake: sc.shake || undefined });
      if (process.env.SAVE && si < 3) writePng(`${outDir}/${design.key}-${si}.png`, img);
      const f0 = performance.now();
      const markers = bench.detect(img)[0].markers;
      frameMs += performance.now() - f0;
      const hits = new Map<number, number>(); // マス → 読めたマーカーの数
      const misses = new Map<number, number>(); // マス → 別の ID に読んだマーカーの数
      for (const m of markers) {
        const cx = (m.corners[0] + m.corners[2] + m.corners[4] + m.corners[6]) / 4;
        const cy = (m.corners[1] + m.corners[3] + m.corners[5] + m.corners[7]) / 4;
        const cell = sc.cells.find((c) => inPoly(c.poly, cx, cy));
        if (!cell) outside++;
        else if (cell.sticker !== m.id) {
          wrong++;
          misses.set(cell.facelet, (misses.get(cell.facelet) ?? 0) + 1);
          if (Math.floor(cell.sticker / 9) === Math.floor(m.id / 9)) wrongSameColor++;
        }
        else hits.set(cell.facelet, (hits.get(cell.facelet) ?? 0) + 1);
      }
      for (const c of sc.cells) {
        if (c.facing < 0.25) continue; // ほぼ真横の面は数えない
        // マスの中で正しい ID が多数（同数を含む）なら読めた
        const ok = (hits.get(c.facelet) ?? 0) >= (misses.get(c.facelet) ?? 0) && hits.has(c.facelet) ? 1 : 0;
        if (!ok && misses.has(c.facelet) && c.facing >= 0.25) cellWrong++;
        if (ok) {
          identified++;
          copies += hits.get(c.facelet)!;
        }
        const add = (t: Tally) => {
          t.n++;
          t.ok += ok;
        };
        add(all);
        add(byPattern[sc.pattern]);
        const b = BINS.findIndex((x, k) => c.occluded <= x && (k === 0 || c.occluded > BINS[k - 1]));
        add(bins[Math.max(0, b)]);
        if (!sc.shake) add(staticBins[Math.max(0, b)]);
        if (c.occluded === 0) {
          add(clear);
          add(byPitch[PITCHES.indexOf(sc.pitch)]);
          add(byShake[SHAKES.indexOf(sc.shake)]);
          if (!sc.shake) add(staticPitch[PITCHES.indexOf(sc.pitch)]);
          if (c.facing < 0.5) add(oblique);
        }
      }
    });
    const look = designLook(design);
    const row = {
      key: design.key,
      label: design.label,
      all: pct(all),
      clear: pct(clear),
      bins: bins.map(pct),
      staticBins: staticBins.map(pct),
      staticBinCounts: staticBins.map((t) => t.n),
      staticPitch: staticPitch.map(pct),
      cellWrongPer1000: ((cellWrong / Math.max(1, all.n)) * 1000).toFixed(1),
      byPitch: byPitch.map(pct),
      byShake: byShake.map(pct),
      byPattern: Object.fromEntries(Object.entries(byPattern).map(([k, v]) => [k, pct(v)])),
      oblique: pct(oblique),
      wrongPer1000: ((wrong / Math.max(1, all.n)) * 1000).toFixed(1),
      wrongSameColorPer1000: ((wrongSameColor / Math.max(1, all.n)) * 1000).toFixed(1),
      outside,
      copiesPerCell: (copies / Math.max(1, identified)).toFixed(2),
      cells: all.n,
      binCounts: bins.map((t) => t.n),
      colorArea: `${(look.colorArea * 100).toFixed(0)}%`,
      meanDeltaE: look.meanDeltaE.toFixed(1),
      minPairDeltaE: look.minPairDeltaE.toFixed(1),
      pairs: look.pairs.map((p) => `${p.pair} ${p.dE.toFixed(0)}`).join(" / "),
      msPerFrame: (frameMs / scenes.length).toFixed(1),
      seconds: ((performance.now() - t0) / 1000).toFixed(0),
    };
    results.push(row);
    console.log(JSON.stringify(row));
  }
  writeFileSync(`${outDir}/results.json`, JSON.stringify({ scenes: scenes.length, pitches: PITCHES, shakes: SHAKES, bins: BINS, results }, null, 2));
  bench.delete();
}, 7200000);

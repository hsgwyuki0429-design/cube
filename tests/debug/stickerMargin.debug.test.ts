// ステッカーの色の余白（マーカーの黒い枠の外側）の有無で、キューブの上のマーカーがどれだけ読めるか。
// 黒い本体のキューブと、ステッカーレス（マスが色の板・ピースの間に黒い溝）のキューブで比べる。
//   npx vitest run -c vitest.debug.config.ts tests/debug/stickerMargin.debug.test.ts
import { createRequire } from "node:module";
import { it } from "vitest";
import { decode } from "../../src/aruco/codes";
import { reconstructFaces } from "../../src/aruco/cube";
import { ArucoBench, DEFAULT_CONFIGS } from "../../src/aruco/detect";
import { VIEW, type Vec3, parseMoves, rotateOrientation } from "../../src/cube/model";
import { initOpenCv } from "../../src/vision/quads";
import { applyMoveStickers, renderArucoCube, solvedStickers, stickerAt } from "../arucoCube";

it("色の余白の比較", async () => {
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const bench = new ArucoBench(cv, [DEFAULT_CONFIGS[1]], "aruco12");
  const states = ["R U F' D2 L", "F R' U B2", "L' D R2 U' F"].map((a) => {
    let st = solvedStickers();
    for (const m of parseMoves(a)) st = applyMoveStickers(st, m);
    return st;
  });
  const orients = [0, rotateOrientation(rotateOrientation(0, "x", 1), "y", 2)];
  const eyes: Vec3[] = [
    [2.4, 2.4, 5.5],
    [1.2, 3.2, 5.0],
    [3.5, 1.5, 4.5],
  ];
  const sizes = [
    { width: 960, height: 720, label: "大" },
    { width: 640, height: 480, label: "中" },
    { width: 480, height: 360, label: "小" },
  ];
  for (const body of ["黒い本体", "ステッカーレス"] as const) {
    for (const sticker of [18 / 19, 15 / 19]) {
      for (const margin of [0.08, 0.04, 0]) {
        const by: Record<string, { ok: number; n: number; cells: number }> = {};
        for (const sz of sizes) {
          const t = (by[sz.label] = { ok: 0, n: 0, cells: 0 });
          let seed = 1;
          for (const st of states)
            for (const orient of orients)
              for (const eye of eyes) {
                const img = renderArucoCube(cv, { ...sz, stickers: st, orient, eye, noise: 2, seed: seed++, scheme: "aruco12", sticker, margin, tile: body === "ステッカーレス" ? 0.96 : undefined });
                const markers = bench.detect(img)[0].markers;
                // 見えているマス（3 面 × 9）に対する、読めたマーカーの数と、面に組み立てて正しい色になったマス
                t.n += 27;
                const r = reconstructFaces(markers, sz, null, "aruco12");
                const at = stickerAt(st);
                for (const f of r.faces) {
                  f.colors.forEach((c, cell) => {
                    if (c < 0) return;
                    const want = Math.floor(at[VIEW[(orient * 6 + f.slot) * 9 + cell]] / 9);
                    if (c === want) t.cells++;
                  });
                }
                t.ok += markers.filter((m) => decode("aruco12", m.id)).length;
              }
        }
        const line = sizes.map((s) => `${s.label} マーカー ${((by[s.label].ok / by[s.label].n) * 100).toFixed(0)}%・面のマス ${((by[s.label].cells / by[s.label].n) * 100).toFixed(0)}%`).join(" | ");
        console.log(`R ${body} ${Math.round(sticker * 19)}mm 余白 ${margin}: ${line}`);
      }
    }
  }
  bench.delete();
});

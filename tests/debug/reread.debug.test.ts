// 再認識（src/aruco/reread.ts）の効果: 組み立てた面の読めなかったマスを切り出して読み直すと、正しく読めるマスがどれだけ増えるか・
// 誤ったマスが増えないか。遠い（マスが小さい）・キューブ全体のぶれで比べる。
//   npx vitest run -c vitest.debug.config.ts tests/debug/reread.debug.test.ts --silent=false
import { createRequire } from "node:module";
import { it } from "vitest";
import { VIEW, type Vec3, parseMoves } from "../../src/cube/model";
import { processAruco } from "../../src/vision/arucoFrame";
import { initOpenCv } from "../../src/vision/quads";
import { applyMoveStickers, renderArucoCube, solvedStickers, stickerAt } from "../arucoCube";

it("再認識の効果", async () => {
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const W = 1280;
  const H = 720;
  const algs = ["R U F' D2 L", "F R' U B2", "L' D R2 U' F", "B U2 R' D F2", "U' L F2 R B'"];
  const dirs: Vec3[] = [
    [0.44, 0.44, 1],
    [0.2, 0.55, 1],
    [0.6, 0.3, 1],
  ];
  for (const pitch of [90, 65, 45]) {
    for (const shake of [0, 0.05, 0.1]) {
      const tally = { base: 0, reread: 0, wrongBase: 0, wrongReread: 0, cells: 0, ms0: 0, ms1: 0, frames: 0 };
      let seed = 1;
      for (const alg of algs)
        for (const dir of dirs) {
          let st = solvedStickers();
          for (const m of parseMoves(alg)) st = applyMoveStickers(st, m);
          const n = Math.hypot(...dir);
          const d = 1.5 + (Math.max(W, H) * 0.8) / pitch;
          const eye: Vec3 = [(dir[0] / n) * d, (dir[1] / n) * d, (dir[2] / n) * d];
          const img = renderArucoCube(cv, { width: W, height: H, stickers: st, orient: 0, eye, noise: 2.5, seed: seed++, scheme: "unique54", shake: shake || undefined });
          const at = stickerAt(st);
          tally.frames++;
          for (const [k, budget] of [
            [0, 0],
            [1, 27],
          ] as const) {
            const t0 = performance.now();
            const r = processAruco(cv, img, 0, {}, "unique54", false, { reread: budget });
            const ms = performance.now() - t0;
            if (k) tally.ms1 += ms;
            else tally.ms0 += ms;
            for (const f of r.faces) {
              f.ids?.forEach((id, cell) => {
                if (id < 0) return;
                const ok = id === at[VIEW[f.slot * 9 + cell]];
                if (k) {
                  if (ok) tally.reread++;
                  else tally.wrongReread++;
                } else if (ok) tally.base++;
                else tally.wrongBase++;
              });
            }
          }
          tally.cells += 27;
        }
      const p = (x: number) => `${((x / tally.cells) * 100).toFixed(1)}%`;
      console.log(
        `pitch ${pitch}px shake ${shake}: 正しいマス ${p(tally.base)} → ${p(tally.reread)}  誤り ${tally.wrongBase} → ${tally.wrongReread}  ${(tally.ms0 / tally.frames).toFixed(0)} → ${(tally.ms1 / tally.frames).toFixed(0)} ms/フレーム`,
      );
    }
  }
}, 3600000);

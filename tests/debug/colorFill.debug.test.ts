// 色による補完（src/aruco/colorFill.ts）の効果: 同じ場面（指・ぶれ・遠さ。tests/arucoScenes.ts）を、補完なし・ありで認識し、
// 見えているマスのうち色が分かったマス（正しい・誤り）を数える。マスの位置は、組み立てた面の格子のマスの中心が入る正解の外枠で照らす。
//   npx vitest run -c vitest.debug.config.ts tests/debug/colorFill.debug.test.ts --silent=false
//   N=場面の数（距離ごと、既定 20）・DESIGNS=standard,quad-half・FINGER=r,g,b（指の色。既定は肌らしい色。実物では暖かい照明で
//   肌らしい色の範囲から外れた指が橙・赤・黄に読まれた: 例 FINGER=235,150,105）
import { createRequire } from "node:module";
import { it } from "vitest";
import { DESIGNS } from "../../src/aruco/design";
import { ARUCO_REFS } from "../../src/aruco/palette";
import { applyH } from "../../src/vision/homography";
import { processAruco } from "../../src/vision/arucoFrame";
import { initOpenCv } from "../../src/vision/image";
import { renderArucoCube } from "../arucoCube";
import { H, W, inPoly, makeScenes } from "../arucoScenes";

it("色による補完の効果", async () => {
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const scenes = makeScenes(Number(process.env.N ?? 20));
  const keys = (process.env.DESIGNS ?? "standard,quad-half").split(",");
  const finger = process.env.FINGER ? (process.env.FINGER.split(",").map(Number) as [number, number, number]) : undefined;
  for (const design of DESIGNS.filter((d) => keys.includes(d.key))) {
    const rows: Record<string, { n: number; base: number; fill: number; wrongBase: number; wrongFill: number }> = {};
    const row = (k: string) => (rows[k] ??= { n: 0, base: 0, fill: 0, wrongBase: 0, wrongFill: 0 });
    scenes.forEach((sc, si) => {
      const fingers = finger ? sc.fingers.map((f) => ({ ...f, color: finger })) : sc.fingers;
      const img = renderArucoCube(cv, { width: W, height: H, stickers: sc.st, orient: sc.orient, eye: sc.eye, noise: 2.5, seed: si + 1, scheme: "unique54", design, fingers, shake: sc.shake || undefined });
      const visible = sc.cells.filter((c) => c.facing >= 0.25);
      const keysOf = (c: (typeof visible)[number]) => ["全体", c.occluded === 0 ? "隠れ 0%" : c.occluded <= 0.5 ? "隠れ 〜50%" : "隠れ 50%〜", `ぶれ ${sc.shake}`];
      for (const c of visible) for (const k of keysOf(c)) row(k).n++;
      for (const fill of [false, true]) {
        const r = processAruco(cv, img, 0, {}, "unique54", false, { colorFill: fill, design: design.key });
        const seen = new Set<number>();
        for (const f of r.faces) {
          if (f.held) continue;
          f.valid.forEach((ok, cell) => {
            if (!ok) return;
            const [x, y] = applyH(f.H, (cell % 3) + 0.5, Math.floor(cell / 3) + 0.5);
            const truth = visible.find((c) => inPoly(c.poly, x, y));
            if (!truth || seen.has(truth.facelet)) return;
            seen.add(truth.facelet);
            const face = Math.floor(truth.sticker / 9);
            const got = labFace(f.labs[cell]);
            for (const k of keysOf(truth)) {
              const t = row(k);
              if (got === face) fill ? t.fill++ : t.base++;
              else fill ? t.wrongFill++ : t.wrongBase++;
            }
          });
        }
      }
    });
    const p = (x: number, n: number) => `${((x / Math.max(1, n)) * 100).toFixed(1)}%`;
    console.log(`== ${design.label}`);
    for (const [k, t] of Object.entries(rows)) console.log(`  ${k.padEnd(8)} 色が分かったマス ${p(t.base, t.n)} → ${p(t.fill, t.n)}  誤り ${t.wrongBase} → ${t.wrongFill}（${t.n} マス）`);
  }
}, 7200000);

// 代表色の Lab（ARUCO_REFS と同じ値）→ 面番号
function labFace(lab: number[]): number {
  return ARUCO_REFS.findIndex((r) => r[0] === lab[0] && r[1] === lab[1] && r[2] === lab[2]);
}

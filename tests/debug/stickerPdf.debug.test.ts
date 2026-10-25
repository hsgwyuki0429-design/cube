// 印刷用 PDF（scripts/aruco-stickers.mjs）を画像にして、アプリの検出器（12 種類）で全部のステッカーが正しく読めるか。
//   node scripts/aruco-stickers.mjs && npx vitest run -c vitest.debug.config.ts tests/debug/stickerPdf.debug.test.ts
// pdftoppm（poppler-utils）が必要
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";
import { colorConsistent } from "../../src/aruco/cube";
import { ArucoBench, DEFAULT_CONFIGS } from "../../src/aruco/detect";
import { type CV, initOpenCv } from "../../src/vision/quads";

let cv: CV;
beforeAll(async () => {
  cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
}, 120000);

const PDF = "docs/stickers/cubevision_aruco12_stickers.pdf";

function readPpm(path: string) {
  const buf = readFileSync(path);
  const head = buf.subarray(0, 64).toString("latin1").split(/\s+/);
  const [width, height] = [Number(head[1]), Number(head[2])];
  const off = buf.length - width * height * 3;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = buf[off + i * 3];
    data[i * 4 + 1] = buf[off + i * 3 + 1];
    data[i * 4 + 2] = buf[off + i * 3 + 2];
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

// 1 ページ目・2 ページ目は 2 セット（面ごとにセンター 1 枚 + 8 枚 × 2）、3 ページ目は 12 種類 × 3 つの大きさ
const EXPECT = [
  Array.from({ length: 12 }, (_, id) => (id >= 6 ? 2 : 16)),
  Array.from({ length: 12 }, (_, id) => (id >= 6 ? 2 : 16)),
  new Array(12).fill(3),
];

for (const dpi of [150, 100]) {
  it(`${dpi}dpi で全ページのステッカーを正しく読む`, () => {
    const dir = mkdtempSync(join(tmpdir(), "stickers-"));
    execFileSync("pdftoppm", ["-r", String(dpi), PDF, join(dir, "p")]);
    const bench = new ArucoBench(cv, [DEFAULT_CONFIGS[1]], "aruco12");
    EXPECT.forEach((want, i) => {
      const img = readPpm(join(dir, `p-${i + 1}.ppm`));
      const markers = bench.detect(img)[0].markers;
      const count = new Array(12).fill(0);
      for (const m of markers) {
        count[m.id]++;
        expect(colorConsistent("aruco12", m.id, m.rgb)).toBe(true);
      }
      expect(count, `ページ ${i + 1}`).toEqual(want);
    });
    bench.delete();
  });
}

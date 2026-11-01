// 録画のフレームを canvas を通さずに RGBA にする変換（src/vision/framePixels.ts）: RGB → YUV（BT.709・BT.601、限られた範囲・全範囲）
// → RGBA で元の色に戻ること。I420・NV12・BGRA、行の詰め物（stride）があっても
import { describe, expect, it } from "vitest";
import { planesToRgba } from "../src/vision/framePixels";

const COLORS: [number, number, number][] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 255],
  [0, 0, 0],
  [255, 140, 0],
  [250, 220, 30],
  [120, 120, 120],
];

// 2×2 ごとに同じ色の画像（色差は 2×2 で 1 つなので、ブロックの中は同じ色にする）
function encode(format: "I420" | "NV12", kr: number, kb: number, full: boolean, w: number, h: number, pad: number) {
  const kg = 1 - kr - kb;
  const color = (x: number, y: number) => COLORS[((x >> 1) + (y >> 1) * 3) % COLORS.length];
  const ys = w + pad;
  const cs = (format === "NV12" ? w : w / 2) + pad;
  const ySize = ys * h;
  const cSize = cs * (h / 2);
  const src = new Uint8Array(ySize + (format === "NV12" ? cSize : cSize * 2));
  const planes = format === "NV12" ? [{ offset: 0, stride: ys }, { offset: ySize, stride: cs }] : [{ offset: 0, stride: ys }, { offset: ySize, stride: cs }, { offset: ySize + cSize, stride: cs }];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = color(x, y).map((v) => v / 255);
      const l = kr * r + kg * g + kb * b;
      const u = (b - l) / (2 * (1 - kb));
      const v = (r - l) / (2 * (1 - kr));
      src[y * ys + x] = Math.round(full ? l * 255 : 16 + l * 219);
      if (x % 2 || y % 2) continue;
      const U = Math.min(255, Math.round(128 + u * (full ? 255 : 224)));
      const V = Math.min(255, Math.round(128 + v * (full ? 255 : 224)));
      const cy = y / 2;
      const cx = x / 2;
      if (format === "NV12") {
        src[ySize + cy * cs + cx * 2] = U;
        src[ySize + cy * cs + cx * 2 + 1] = V;
      } else {
        src[ySize + cy * cs + cx] = U;
        src[ySize + cSize + cy * cs + cx] = V;
      }
    }
  return { src, planes, color };
}

describe("planesToRgba", () => {
  for (const format of ["I420", "NV12"] as const)
    for (const [matrix, kr, kb] of [
      ["bt709", 0.2126, 0.0722],
      ["smpte170m", 0.299, 0.114],
    ] as const)
      for (const full of [false, true])
        it(`${format} ${matrix} ${full ? "全範囲" : "限られた範囲"}`, () => {
          const w = 12;
          const h = 8;
          const { src, planes, color } = encode(format, kr, kb, full, w, h, 4);
          const out = planesToRgba(src, planes, format, w, h, matrix, full);
          for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
              const c = color(x, y);
              for (let k = 0; k < 3; k++) expect(Math.abs(out[(y * w + x) * 4 + k] - c[k])).toBeLessThanOrEqual(3);
              expect(out[(y * w + x) * 4 + 3]).toBe(255);
            }
        });

  it("BGRA（行の詰め物あり）", () => {
    const w = 3;
    const h = 2;
    const stride = w * 4 + 8;
    const src = new Uint8Array(stride * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const [r, g, b] = COLORS[x + y * w];
        src.set([b, g, r, 0], y * stride + x * 4);
      }
    const out = planesToRgba(src, [{ offset: 0, stride }], "BGRA", w, h);
    for (let i = 0; i < w * h; i++) expect([...out.slice(i * 4, i * 4 + 4)]).toEqual([...COLORS[i], 255]);
  });
});

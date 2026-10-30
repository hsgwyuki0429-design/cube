// ステッカーの中のマーカーの配置（大きさ・個数・暗いマスの色）。符号（codes.ts）とは別に選ぶ。
// 座標はステッカーの左上 = (0, 0)、右下 = (1, 1)。マーカーの辺 side は黒い枠を含む模様の辺（ステッカーの辺 = 1）。
// 今のステッカー（standard）は色の縁 8% の内側いっぱいに 1 個（辺 0.84）。小さくすると、空いた部分はステッカーの色になる。
// 4 個のものは同じ ID・同じ向きのマーカーを 2×2 に並べる（指で一部が隠れても、どれかが丸ごと見えるように）。
// 本体の重い依存を持たない（印刷用スクリプト scripts/aruco-stickers.mjs に同じ値がある。tests/aruco.test.ts で照合）
import { type Lab, deltaE76, rgbToLab } from "../vision/color";
import { type StickerScheme, codesOf } from "./codes";
import { PRINT_COLORS } from "./palette";

export type Ink = "black" | "shade";

export interface StickerDesign {
  key: string;
  label: string;
  side: number; // マーカーの辺（ステッカーの辺 = 1）
  at: [number, number][]; // マーカーの中心
  ink: Ink; // 暗いマス（黒い枠を含む）: 黒 / ステッカーと同じ色の濃い色
}

export const INK_BLACK = "#1a1a1a"; // 印刷用 PDF の黒
export const SHADE = 0.35; // 濃い同色: 印刷色の各チャンネル × これ

const CENTER: [number, number][] = [[0.5, 0.5]];
const QUAD: [number, number][] = [
  [0.25, 0.25],
  [0.75, 0.25],
  [0.25, 0.75],
  [0.75, 0.75],
];

// 4 個・幅 1/2 は 2×2 に収まる最大（外側の縁 0.06・マーカーの間 0.08。18mm で 7.2mm）。幅 1/3 は 1 個と同じ 0.28（5mm）
const BASE: Omit<StickerDesign, "ink">[] = [
  { key: "standard", label: "現状（1 個・幅 1）", side: 0.84, at: CENTER },
  { key: "half", label: "1 個・幅 1/2", side: 0.42, at: CENTER },
  { key: "third", label: "1 個・幅 1/3", side: 0.28, at: CENTER },
  { key: "quad-half", label: "4 個・幅 1/2", side: 0.4, at: QUAD },
  { key: "quad-third", label: "4 個・幅 1/3", side: 0.28, at: QUAD },
];

export const DESIGNS: StickerDesign[] = [
  ...BASE.map((d) => ({ ...d, ink: "black" as const })),
  ...BASE.map((d) => ({ ...d, key: `${d.key}-shade`, label: `${d.label}・濃い同色`, ink: "shade" as const })),
];
export const STANDARD_DESIGN = DESIGNS[0];
export const designOf = (key: string): StickerDesign => DESIGNS.find((d) => d.key === key) ?? STANDARD_DESIGN;

export const hexRgb = (h: string): [number, number, number] => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number];

// 暗いマスの色（sRGB）
export function inkRgb(d: StickerDesign, face: number): [number, number, number] {
  if (d.ink === "black") return hexRgb(INK_BLACK);
  return hexRgb(PRINT_COLORS[face]).map((v) => Math.round(v * SHADE)) as [number, number, number];
}

const popcount = (x: number) => {
  let k = 0;
  while (x) (x &= x - 1), k++;
  return k;
};

// ID ごとの明るいマスの割合（枠を含む 5×5 のうち）。3×3 の符号のみ（4×4 の 54 種類は 6×6 の 16 ビットで近似しない）
function lightRate(scheme: StickerScheme): number[] {
  return codesOf(scheme).map((c) => popcount(c) / 25);
}

export interface DesignLook {
  colorArea: number; // ステッカーのうち印刷色（明るい色）の面積の割合（54 枚の平均）
  meanDeltaE: number; // 離れて見たときの平均色と印刷色の差（ΔE76、54 枚の平均）。小さいほど無地のステッカーに近い
  minPairDeltaE: number; // 6 色の平均色どうしの差の最小（見分けやすさ）
  pairs: { pair: string; dE: number }[]; // 紛れやすい組（白–黄・赤–橙・黄–橙）の差
}

// 離れて見た色: 線形の光で面積の割合に混ぜる
const toLinear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (c: number) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
function mix(a: [number, number, number], b: [number, number, number], wa: number): Lab {
  const m = [0, 1, 2].map((k) => toSrgb(wa * toLinear(a[k]) + (1 - wa) * toLinear(b[k])));
  return rgbToLab(m[0], m[1], m[2]);
}

// 人に見える色（印刷色の面積・離れて見た色）。scheme の符号の明るいビットの数で ID ごとに計算する
export function designLook(d: StickerDesign, scheme: StickerScheme = "unique54"): DesignLook {
  const rates = lightRate(scheme);
  const n = rates.length;
  const faceOf = (id: number) => (scheme === "aruco12" ? id % 6 : Math.floor(id / 9));
  const markerArea = d.at.length * d.side * d.side;
  let area = 0;
  let dE = 0;
  const sums: Lab[] = Array.from({ length: 6 }, () => [0, 0, 0]);
  const counts = new Array(6).fill(0);
  for (let id = 0; id < n; id++) {
    const f = faceOf(id);
    const light = 1 - markerArea + markerArea * rates[id];
    area += light / n;
    const print = hexRgb(PRINT_COLORS[f]);
    const seen = mix(print, inkRgb(d, f), light);
    dE += deltaE76(seen, rgbToLab(...print)) / n;
    for (let k = 0; k < 3; k++) sums[f][k] += seen[k];
    counts[f]++;
  }
  const means = sums.map((s, f) => s.map((v) => v / counts[f]) as Lab);
  let minPair = Infinity;
  for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) minPair = Math.min(minPair, deltaE76(means[i], means[j]));
  const names = ["白", "赤", "緑", "黄", "橙", "青"];
  const pairs = [
    [0, 3],
    [1, 4],
    [3, 4],
  ].map(([i, j]) => ({ pair: `${names[i]}–${names[j]}`, dE: deltaE76(means[i], means[j]) }));
  return { colorArea: area, meanDeltaE: dE, minPairDeltaE: minPair, pairs };
}

// 色による補完: 組み立てた面のうちマーカーを読めなかったマス（指が一部にかかった・ぶれた）の色を測り、同じフレームで読めた
// マーカーの色（ID から面が分かっている）と比べて、そのマスの色を弱い観測として補う。マーカーはビットが鮮明でないと読めないが、
// ステッカーの色（外側の色の縁・明るいマス）は少しぶれても指が少しかかっても残る。
// 照明で色がずれても、同じフレームの同じ色のステッカーは同じようにずれるので、そのフレームのマーカーの色を基準にする。
// どの色にも十分近くない・2 番目の色とあまり差がない・肌らしい読みは「不明」のまま（決めつけない）。ID は分からないので色だけ。
// DOM もカメラも知らない
import { rgbToLab } from "../vision/color";
import { skinLike } from "../track/colorModel";
import { type Mat3, applyH } from "../vision/homography";
import type { VisibleFace } from "./cube";
import type { ImageLike } from "./detect";

export interface ColorFillOptions {
  maxDist: number; // 色味（各チャンネルを最大のチャンネルで割った値）の距離がこれ以下で
  ratio: number; // 2 番目に近い色との距離の比がこれ以上
  minBright: number; // 色の点として使う明るさ（max(R,G,B)）の下限
}

export const DEFAULT_COLOR_FILL: ColorFillOptions = { maxDist: 0.16, ratio: 1.8, minBright: 70 };

// 補ったマスの確からしさ（読んだマーカーの 1 に対して）。色だけで、ID は分からない
export const COLOR_CONF = 0.5;

type Chroma = [number, number, number];
const chroma = (rgb: readonly number[]): Chroma => {
  const m = Math.max(rgb[0], rgb[1], rgb[2], 1);
  return [rgb[0] / m, rgb[1] / m, rgb[2] / m];
};
const dist = (a: Chroma, b: Chroma) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
};

// フレームの色の基準: 面（色）ごとに、読めたマーカーの明るいマスの色味の中央値（その色のマーカーがなければ null）
export function frameRefs(markers: { rgb: [number, number, number]; face: number }[]): (Chroma | null)[] {
  return Array.from({ length: 6 }, (_, f) => {
    const xs = markers.filter((m) => m.face === f).map((m) => chroma(m.rgb));
    return xs.length ? ([0, 1, 2].map((k) => median(xs.map((x) => x[k]))) as Chroma) : null;
  });
}

// マス cell（面の座標 x = 列・y = 行、H: → 画像）の明るい点の色（RGB の中央値）。明るい点が少なければ null。
// マスの内側 8〜92% を 11×11 点で見て、明るさの上位 35%（ステッカーの色。マーカーの黒・隙間の黒い本体を除く）から肌らしい点を除く
export function cellColor(img: ImageLike, H: Mat3, cell: number, o: ColorFillOptions = DEFAULT_COLOR_FILL): [number, number, number] | null {
  const r = Math.floor(cell / 3);
  const c = cell % 3;
  const pts: { v: number; rgb: [number, number, number] }[] = [];
  for (let i = 0; i < 11; i++)
    for (let j = 0; j < 11; j++) {
      const [x, y] = applyH(H, c + 0.08 + (0.84 * (j + 0.5)) / 11, r + 0.08 + (0.84 * (i + 0.5)) / 11);
      const xi = Math.round(x);
      const yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) continue;
      const k = (yi * img.width + xi) * 4;
      const rgb: [number, number, number] = [img.data[k], img.data[k + 1], img.data[k + 2]];
      pts.push({ v: Math.max(...rgb), rgb });
    }
  if (pts.length < 60) return null;
  pts.sort((a, b) => b.v - a.v);
  const top = pts.slice(0, Math.round(pts.length * 0.35)).filter((p) => p.v >= o.minBright && !skinLike(rgbToLab(...p.rgb)));
  if (top.length < 12) return null;
  return [0, 1, 2].map((k) => median(top.map((p) => p.rgb[k]))) as [number, number, number];
}

// マスの中で肌らしい点の割合（内側 8〜92% を 7×7 点）。指がかかっているか
export function skinFraction(img: ImageLike, H: Mat3, cell: number): number {
  const r = Math.floor(cell / 3);
  const c = cell % 3;
  let n = 0;
  let skin = 0;
  for (let i = 0; i < 7; i++)
    for (let j = 0; j < 7; j++) {
      const [x, y] = applyH(H, c + 0.08 + (0.84 * (j + 0.5)) / 7, r + 0.08 + (0.84 * (i + 0.5)) / 7);
      const xi = Math.round(x);
      const yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) continue;
      const k = (yi * img.width + xi) * 4;
      n++;
      if (skinLike(rgbToLab(img.data[k], img.data[k + 1], img.data[k + 2]))) skin++;
    }
  return n ? skin / n : 0;
}

// rgb をフレームの基準の色に分ける。十分近く、2 番目と差があるときだけ（なければ -1）
export function classifyByFrame(rgb: [number, number, number], refs: (Chroma | null)[], o: ColorFillOptions = DEFAULT_COLOR_FILL): number {
  if (skinLike(rgbToLab(...rgb))) return -1;
  const x = chroma(rgb);
  let best = -1;
  let d1 = Infinity;
  let d2 = Infinity;
  refs.forEach((ref, f) => {
    if (!ref) return;
    const d = dist(x, ref);
    if (d < d1) {
      d2 = d1;
      d1 = d;
      best = f;
    } else if (d < d2) d2 = d;
  });
  if (best < 0 || d1 > o.maxDist || d2 < d1 * o.ratio) return -1;
  return best;
}

// 面の読めなかったマスを色で補う。補ったマスは colors を書き換え（ids は -1 のまま）、確からしさ COLOR_CONF。
// 外枠が推定の面（1 列・1 枚）はマスの位置が確かでないので使わない。補ったマスの番号（slot * 9 + cell）を返す
export function fillByColor(img: ImageLike, faces: VisibleFace[], refs: (Chroma | null)[], o: ColorFillOptions = DEFAULT_COLOR_FILL): Set<number> {
  const got = new Set<number>();
  if (refs.filter(Boolean).length < 2) return got; // 比べる色が 1 つしかなければ、どの色かを決められない
  for (const f of faces) {
    if (f.partial) continue;
    for (let cell = 0; cell < 9; cell++) {
      if (f.colors[cell] >= 0) continue;
      const rgb = cellColor(img, f.H, cell, o);
      if (!rgb) continue;
      const c = classifyByFrame(rgb, refs, o);
      if (c < 0) continue;
      f.colors[cell] = c;
      f.conf[cell] = COLOR_CONF;
      got.add(f.slot * 9 + cell);
    }
  }
  return got;
}

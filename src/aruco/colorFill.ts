// 色による補完: 組み立てた面のうちマーカーを読めなかったマス（指が一部にかかった・ぶれた）の色を測り、同じフレームで読めた
// マーカーの色（ID から面が分かっている）と比べて、そのマスの色を弱い観測として補う。マーカーはビットが鮮明でないと読めないが、
// ステッカーの色（マーカーの黒い枠のすぐ外側の色の縁）は少しぶれても指が少しかかっても残る。色を測るのはその縁だけで、すぐ内側の
// 黒い枠が見えている所に限る（指は黒くないので、指のかかった所は使わない）。
// 照明で色がずれても、同じフレームの同じ色のステッカーは同じようにずれるので、そのフレームのマーカーの色を基準にする。
// どの色にも十分近くない・2 番目の色とあまり差がない・肌らしい読みは「不明」のまま（決めつけない）。ID は分からないので色だけ。
// DOM もカメラも知らない
import { rgbToLab } from "../vision/color";
import { skinLike } from "../track/colorModel";
import { type Mat3, applyH } from "../vision/homography";
import type { VisibleFace } from "./cube";
import { STANDARD_DESIGN, type StickerDesign } from "./design";
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

// マーカーの黒い枠のすぐ外側（ステッカーの色の縁）の測り方。マスの中の明るい点を全部使うと、指（明るい）の色を拾っていた
// （実物で、暖かい照明の指が肌らしい色の範囲から外れて橙・赤・黄に読まれた）。枠のすぐ外側の点を、そのすぐ内側の黒い枠の点と
// 組にして、内側が暗く外側が明るい組（指がかかっていれば内側も明るいか、外側の色が指になる）だけを使う
export interface RingGeometry {
  markers: { x: number; y: number; half: number }[]; // マスの中のマーカーの中心（マスの中心から）と辺の半分（仮想のマーカーの辺 = 1）
  out: number; // 枠の外側の点: マーカーの辺からの距離（同じ単位）
  inside: number; // 枠の内側の点: マーカーの辺からの距離（黒い枠の太さの半分）
}

// 配置 design・符号のマスの数 bits（3×3 は 3、4×4 は 4）の、仮想のマーカー（ステッカーの 0.08〜0.92）を辺 1 とした縁の位置
export function ringGeometry(design: StickerDesign, bits: number): RingGeometry {
  const S = 1 / (STANDARD_DESIGN.side); // ステッカーの辺
  const half = (design.side * S) / 2;
  // 縁の幅: マーカーからステッカーの端までと、隣のマーカーとの間の半分のうち狭い方
  let margin = Infinity;
  for (const [x, y] of design.at) {
    margin = Math.min(margin, x - design.side / 2, 1 - x - design.side / 2, y - design.side / 2, 1 - y - design.side / 2);
    for (const [x2, y2] of design.at)
      if ((x2 !== x || y2 !== y) && (x2 === x || y2 === y)) margin = Math.min(margin, (Math.abs(x2 - x) + Math.abs(y2 - y) - design.side) / 2);
  }
  return {
    markers: design.at.map(([x, y]) => ({ x: (x - 0.5) * S, y: (y - 0.5) * S, half })),
    out: (margin / 2) * S,
    inside: (design.side * S) / (bits + 2) / 2,
  };
}

const STANDARD_RING = ringGeometry(STANDARD_DESIGN, 3);
const SIDE_POINTS = [0.2, 0.35, 0.5, 0.65, 0.8];

// マス cell（面の座標 x = 列・y = 行、H: → 画像。marker: 仮想のマーカーの辺、マスの間隔 = 1）の色を、枠のすぐ外側の点から分ける。
// マーカーの辺ごと（4 個の配置は 4 個 × 4 辺）に、使える点の色の中央値をフレームの色に分け、2 辺以上が同じ色で、ほかの色の辺の
// 2 倍以上あるときだけ（なければ -1）。指がかかった辺は点が使えないか、指の色に分かれて数で負ける
export function ringClass(img: ImageLike, H: Mat3, cell: number, marker: number, refs: (Chroma | null)[], ring: RingGeometry = STANDARD_RING, o: ColorFillOptions = DEFAULT_COLOR_FILL): number {
  const cx = (cell % 3) + 0.5;
  const cy = Math.floor(cell / 3) + 0.5;
  const at = (u: number, v: number): [number, number, number] | null => {
    const [x, y] = applyH(H, cx + u * marker, cy + v * marker);
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) return null;
    const k = (yi * img.width + xi) * 4;
    return [img.data[k], img.data[k + 1], img.data[k + 2]];
  };
  const votes = new Array<number>(6).fill(0);
  for (const m of ring.markers)
    for (let side = 0; side < 4; side++) {
      const pts: [number, number, number][] = [];
      for (const t of SIDE_POINTS) {
        const along = (t - 0.5) * 2 * m.half;
        // 辺の外向き（0 上・1 右・2 下・3 左）
        const [nx, ny] = [
          [0, -1],
          [1, 0],
          [0, 1],
          [-1, 0],
        ][side];
        const base = (d: number): [number, number] => [m.x + nx * (m.half + d) + ny * along, m.y + ny * (m.half + d) - nx * along];
        const p = at(...base(ring.out));
        const q = at(...base(-ring.inside));
        if (!p || !q) continue;
        const vp = Math.max(...p);
        const vq = Math.max(...q);
        if (vp < o.minBright || vq > vp * 0.6) continue;
        if (skinLike(rgbToLab(...p))) continue;
        pts.push(p);
      }
      if (pts.length < 2) continue;
      const c = classifyByFrame([0, 1, 2].map((k) => median(pts.map((x) => x[k]))) as [number, number, number], refs, o);
      if (c >= 0) votes[c]++;
    }
  let best = -1;
  for (let f = 0; f < 6; f++) if (best < 0 || votes[f] > votes[best]) best = f;
  const others = votes.reduce((sum, v, f) => (f === best ? sum : Math.max(sum, v)), 0);
  return votes[best] >= 2 && votes[best] >= others * 2 ? best : -1;
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
export function fillByColor(img: ImageLike, faces: VisibleFace[], refs: (Chroma | null)[], ring: RingGeometry = STANDARD_RING, o: ColorFillOptions = DEFAULT_COLOR_FILL): Set<number> {
  const got = new Set<number>();
  if (refs.filter(Boolean).length < 2) return got; // 比べる色が 1 つしかなければ、どの色かを決められない
  for (const f of faces) {
    if (f.partial || !f.marker) continue;
    for (let cell = 0; cell < 9; cell++) {
      if (f.colors[cell] >= 0) continue;
      const c = ringClass(img, f.H, cell, f.marker, refs, ring, o);
      if (c < 0) continue;
      f.colors[cell] = c;
      f.conf[cell] = COLOR_CONF;
      got.add(f.slot * 9 + cell);
    }
  }
  return got;
}

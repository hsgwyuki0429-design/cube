// ステッカーの同一性: 色の状態（54 枚の色）から「facelet f にあるのは、揃った状態でどの facelet にあったステッカーか」を求める。
// 3×3 のピースは色の組み合わせで区別できるので、色の状態が分かれば各ステッカーの身元も決まる（センターは動かない）。
// マスごとに違う ArUco ステッカー（unique54・4×4 の 54 種類）は ID = 揃った状態での facelet 番号なので、
// 読んだ ID と仮説の状態のこの値を照らせる（同じ色のどのステッカーかまで照合する）。DOM もカメラも知らない
import { type CubeState, type Vec3, faceletGeometry } from "./model";

const GEOM = Array.from({ length: 54 }, (_, i) => faceletGeometry(i));
const det3 = (a: Vec3, b: Vec3, c: Vec3) => a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);

// 同じピースの他の facelet（エッジ 1・コーナー 2・センター 0）。コーナーは外から見て反時計回りの順（det[n, n1, n2] > 0）。
// 回転で向きの順は変わらないので、どの状態でも同じ順で色を読める
export const PARTNERS: number[][] = GEOM.map((g, i) => {
  const mates = GEOM.map((h, j) => ({ h, j })).filter(({ h, j }) => j !== i && h.pos.every((v, k) => v === g.pos[k]));
  if (mates.length === 2 && det3(g.normal, mates[0].h.normal, mates[1].h.normal) < 0) mates.reverse();
  return mates.map((m) => m.j);
});

// 色の組（自分の色, 相手の色…）→ 揃った状態での facelet（エッジとコーナーで別の表）
const EDGE_HOME = new Int16Array(6 * 6).fill(-1);
const CORNER_HOME = new Int16Array(6 * 6 * 6).fill(-1);
for (let i = 0; i < 54; i++) {
  const p = PARTNERS[i];
  const face = (j: number) => Math.floor(j / 9);
  if (p.length === 1) EDGE_HOME[face(i) * 6 + face(p[0])] = i;
  else if (p.length === 2) CORNER_HOME[(face(i) * 6 + face(p[0])) * 6 + face(p[1])] = i;
}

// facelet f にあるステッカー（揃った状態での facelet 番号）。ありえない色の組なら -1
export function stickerIdAt(state: CubeState | number[], f: number): number {
  const p = PARTNERS[f];
  if (p.length === 1) return EDGE_HOME[state[f] * 6 + state[p[0]]];
  if (p.length === 2) return CORNER_HOME[(state[f] * 6 + state[p[0]]) * 6 + state[p[1]]];
  return f; // センター
}

// 54 マスすべて
export function stickerIds(state: CubeState | number[]): Int16Array {
  const out = new Int16Array(54);
  for (let f = 0; f < 54; f++) out[f] = stickerIdAt(state, f);
  return out;
}

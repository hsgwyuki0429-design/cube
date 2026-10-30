// キューブモード: 検出した ArUco マーカー（ID 0〜53）から、見えている面を組み立てて観測にし、
// 追跡のデコーダ（src/track）で手順を推定する。DOM もカメラも知らない（Node でも動く）。
//
// ID = 揃った状態での facelet 番号なので、ID÷9 がそのステッカーの色（センターの面）。色を読む代わりに確かな色が分かる。
// 面の組み立て: マーカー 1 枚の 4 隅からその面の平面の射影変換が分かる。同じ面のマーカーはその座標で
// 「ほぼ同じ大きさの、軸にそろった正方形」が格子の間隔で並ぶ。直交する面や回している途中の層はそうならないので外れる。
import { NORMAL, ROWDIR, VIEW, applyMove, faceletGeometry, moveFace, solvedState } from "../cube/model";
import { DEFAULT_OFFLINE, decodeOffline } from "../track/offline";
import { simplifyMoves } from "../track/merge";
import type { DecodedMove, FaceObservation, Observation } from "../track/types";
import { type Mat3, type Pt, applyH, fitHomography, invertH } from "../vision/homography";
import { defaultFocal } from "../vision/pose";
import { CONFUSABLE12, type Decoded, type StickerScheme, centerOffset, decode } from "./codes";
import type { Marker } from "./detect";
import { type ColorKey, FACE_COLORS, classifyColor } from "./stickers";

export interface VisibleFace {
  slot: number; // カメラフレームの面（0 上 / 1 右 / 2 正面 / 3 下 / 4 左）
  colors: number[]; // 9 セル（row*3+col、行 = 画像の下向き・列 = 右向き）のステッカーの色（センターの面 0〜5）。-1 = 見えない
  ids: number[]; // 同じ並びのステッカー（揃った状態での facelet 番号）。54 種類の符号のときだけ。分からなければ -1
  conf: number[]; // 同じ並びの、読みの確からしさ（0〜1。マーカーのマスの中心の明暗が符号どおりの割合 fit から: readConfidence）
  outline: Pt[]; // 3×3 の外枠（画像座標、左上から時計回り）
  H: Mat3; // 面の座標（x = 列・y = 行、0〜3）→ 画像。本体の認識の DetectedFace（rot = 0）と同じ
  partial?: boolean; // 1 列（1×3・1×2）か 1 枚だけの面（外枠は推定。3D の傾きの計算には使わない）
}

export interface FaceOptions {
  sideTol: number; // 辺の長さの許容（基準のマーカーとの比 1 ± これ）
  angleTol: number; // 軸からのずれの許容（度）
  posTol: number; // 格子の点からのずれの許容（格子の間隔に対する割合）
  pitchRange: [number, number]; // 格子の間隔（マーカーの辺に対する比）の範囲
}

export const DEFAULT_FACE: FaceOptions = {
  sideTol: 0.3,
  angleTol: 14,
  posTol: 0.28,
  pitchRange: [1.05, 1.9], // 18mm のステッカー（マーカー 15mm）を 19mm 間隔で貼ると 1.26、15mm なら 1.5
};

const UNIT: Pt[] = [
  [-0.5, -0.5],
  [0.5, -0.5],
  [0.5, 0.5],
  [-0.5, 0.5],
];

const cornersOf = (m: Marker): Pt[] => [0, 1, 2, 3].map((i) => [m.corners[i * 2], m.corners[i * 2 + 1]]);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
};

interface Member {
  m: Marker;
  rot: number; // マーカーの向き（基準の座標で 90° 単位）
  du: number; // 中心の位置（基準のマーカーの辺 = 1 の座標）
  dv: number;
}

// マーカー n を基準の座標（Hi: 画像 → 基準）で見たとき、軸にそろった正方形なら向きと中心
function inFrame(Hi: Mat3, n: Marker, o: FaceOptions): Member | null {
  const q = cornersOf(n).map(([x, y]) => applyH(Hi, x, y));
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (Math.abs(len - 1) > o.sideTol) return null;
  }
  const ang = (Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0]) * 180) / Math.PI;
  const k = Math.round(ang / 90);
  if (Math.abs(ang - k * 90) > o.angleTol) return null;
  const ang2 = (Math.atan2(q[2][1] - q[1][1], q[2][0] - q[1][0]) * 180) / Math.PI;
  const d2 = (((ang2 - ang - 90) % 360) + 540) % 360 - 180;
  if (Math.abs(d2) > o.angleTol) return null; // 鏡像・ひどい歪み
  return { m: n, rot: ((k % 4) + 4) % 4, du: (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, dv: (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4 };
}

interface Group {
  cells: Map<string, { m: Marker; rot: number; i: number; j: number; res: number }>;
  G: Mat3; // 基準の座標（マーカーの辺 = 1、基準のマーカーの中心が原点）→ 画像
  pitch: number;
}

function gatherGroup(ref: Marker, pool: Marker[], o: FaceOptions): Group | null {
  let G = fitHomography(UNIT, cornersOf(ref));
  if (!G) return null;
  let pitch = 0;
  let cells = new Map<string, { m: Marker; rot: number; i: number; j: number; res: number }>();
  for (let pass = 0; pass < 2; pass++) {
    const Gi = invertH(G);
    const cands = pool.map((n) => (n === ref ? { m: n, rot: 0, du: 0, dv: 0 } : inFrame(Gi, n, o))).filter((c): c is Member => !!c && Math.hypot(c.du, c.dv) < 4.5);
    if (pass === 0) {
      // 格子の間隔: 縦か横に隣り合う候補の距離の中央値
      const near: number[] = [];
      for (const c of cands) {
        const a = Math.abs(c.du);
        const b = Math.abs(c.dv);
        const d = Math.max(a, b);
        if (Math.min(a, b) < 0.3 && d >= o.pitchRange[0] && d <= o.pitchRange[1]) near.push(d);
      }
      pitch = near.length ? median(near) : 0;
      if (!pitch) return { cells: new Map([["0,0", { m: ref, rot: 0, i: 0, j: 0, res: 0 }]]), G, pitch: 0 };
    }
    cells = new Map();
    for (const c of cands) {
      const i = Math.round(c.du / pitch);
      const j = Math.round(c.dv / pitch);
      if (Math.abs(i) > 2 || Math.abs(j) > 2) continue;
      const res = Math.hypot(c.du - i * pitch, c.dv - j * pitch) / pitch;
      if (res > o.posTol) continue;
      const key = `${i},${j}`;
      const prev = cells.get(key);
      if (!prev || res < prev.res) cells.set(key, { m: c.m, rot: c.rot, i, j, res });
    }
    // 3×3 に収まらない（離れた 2 つの面が同じ平面に見えた）ときは基準に近い方だけ
    const is = [...cells.values()].map((c) => c.i);
    const js = [...cells.values()].map((c) => c.j);
    if (Math.max(...is) - Math.min(...is) > 2 || Math.max(...js) - Math.min(...js) > 2) {
      for (const [k, c] of cells) if (Math.abs(c.i) + Math.abs(c.j) > 2) cells.delete(k);
    }
    // 見つかったマーカーの角すべてで射影変換を当て直す（遠くのマーカーの位置が正確になる）
    const src: Pt[] = [];
    const dst: Pt[] = [];
    for (const c of cells.values()) {
      const pts = cornersOf(c.m);
      for (let k = 0; k < 4; k++) {
        const u = UNIT[(k + c.rot) % 4];
        src.push([c.i * pitch + u[0], c.j * pitch + u[1]]);
        dst.push(pts[k]);
      }
    }
    const refit = fitHomography(src, dst);
    if (refit) G = refit;
  }
  return { cells, G, pitch };
}

export interface FacesResult {
  faces: VisibleFace[];
  tilt: number[] | null; // キューブの傾き（カメラフレームに揃ったキューブ → 実際、行優先 3×3）。次のフレームの事前分布に使う
}

// 1 フレームのマーカーから、見えている面（カメラフレームの面に割り当て、セルの並びもカメラフレームの規約）を作る。
// prevTilt: 直前のフレームのキューブの傾き。面が 1 つしか見えないときも、上面の向き（どちらが正面側か）を決められる
// 写った色（マーカーの明るいセルの平均）が、読んだ ID の色と明らかに違えば誤読として捨てる。
// カメラの色は照明で揺れるので、白と黄・赤と橙・黄と橙は区別しない
const CLOSE: Record<ColorKey, ColorKey[]> = {
  white: ["white", "yellow"],
  red: ["red", "orange"],
  green: ["green"],
  yellow: ["yellow", "white", "orange"],
  orange: ["orange", "red", "yellow"],
  blue: ["blue"],
};
// 54 種類: 写った色が ID の色に近いこと。
// 12 種類: 誤り訂正がないので、2 ビットの読み違いで入れ替わりうる ID（CONFUSABLE12）の色に見えて、自分の色には見えないときだけ捨てる。
// 色そのものが合うことは求めない: 印刷した薄い青・緑は暖かい照明の下で灰色・黄緑に写り（実物の動画で青の 92%・緑の 69% が
// 「白」「黄」と判定された）、正しいマーカーを捨てて正面が見つからなくなっていた
export function colorConsistent(scheme: StickerScheme, id: number, rgb: [number, number, number]): boolean {
  const dec = decode(scheme, id);
  if (!dec) return false;
  const c = classifyColor(rgb);
  if (CLOSE[FACE_COLORS[dec.face]].includes(c)) return true;
  if (scheme === "aruco54") return false;
  // unique54 は距離 2 の相手がほぼ全色にいるので、1 枚ずつは判定しない（同じフレームの他のマーカーと比べる: frameColorFilter）
  if (scheme === "unique54") return true;
  return !CONFUSABLE12[id].some((j) => FACE_COLORS[decode(scheme, j)!.face] === c);
}

// 写った色を同じフレームの他のマーカーの色と比べる（unique54）。照明で色がずれても同じ色のステッカーは同じようにずれるので、
// 読んだ色の仲間（自分を除く）より別の色の仲間にずっと近いマーカーを誤読として捨てる。色味は最大のチャンネルで割って比べる（明暗によらない）
export function frameColorFilter<T extends { rgb: [number, number, number]; face: number }>(ms: T[]): T[] {
  const chroma = (rgb: [number, number, number]) => {
    const m = Math.max(rgb[0], rgb[1], rgb[2], 1);
    return [rgb[0] / m, rgb[1] / m, rgb[2] / m];
  };
  const xs = ms.map((m) => chroma(m.rgb));
  const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const med = (vs: number[][]) => [0, 1, 2].map((k) => median(vs.map((v) => v[k])));
  return ms.filter((m, i) => {
    let own: number | null = null;
    let other = Infinity;
    for (let f = 0; f < 6; f++) {
      const group = xs.filter((_, j) => j !== i && ms[j].face === f);
      if (f === m.face) {
        if (group.length) own = dist(xs[i], med(group));
      } else if (group.length >= 2) other = Math.min(other, dist(xs[i], med(group)));
    }
    if (own === null) return other > 0.1;
    return !(other < 0.15 && other < own * 0.5);
  });
}

// 同じ色の仲間（自分を除いて 2 枚以上）の色味の中央値にごく近く、取り違えの相手の色の仲間よりも近いマーカー（12 種類）
function supportedByFrame(ms: { m: Marker; face: number }[]): Set<Marker> {
  const chroma = (rgb: [number, number, number]) => {
    const k = Math.max(rgb[0], rgb[1], rgb[2], 1);
    return [rgb[0] / k, rgb[1] / k, rgb[2] / k];
  };
  const xs = ms.map((x) => chroma(x.m.rgb));
  const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const medianOf = (face: number, skip: number) => {
    const g = xs.filter((_, j) => j !== skip && ms[j].face === face);
    return g.length >= 2 ? [0, 1, 2].map((k) => median(g.map((v) => v[k]))) : null;
  };
  const out = new Set<Marker>();
  ms.forEach((x, i) => {
    const own = medianOf(x.face, i);
    if (!own || dist(xs[i], own) > 0.12) return;
    const partners = CONFUSABLE12[x.m.id].map((j) => medianOf(j % 6, i)).filter((v): v is number[] => !!v);
    if (partners.every((p) => dist(xs[i], own) < dist(xs[i], p))) out.add(x.m);
  });
  return out;
}

// 色の基準に使えるマーカー（ID から色が分かり、写った色が ID の色と食い違わないもの）の写った色と面（色による補完の基準: colorFill.ts）
export function trustedColors(markers: Marker[], scheme: StickerScheme): { rgb: [number, number, number]; face: number }[] {
  const dec = markers.flatMap((m) => {
    const d = decode(scheme, m.id);
    return d ? [{ ...m, face: d.face }] : [];
  });
  const kept = scheme === "unique54" ? frameColorFilter(dec) : dec.filter((m) => colorConsistent(scheme, m.id, m.rgb));
  return kept.map((m) => ({ rgb: m.rgb, face: m.face }));
}

interface Coded extends Marker {
  dec: Decoded;
}

export function reconstructFaces(
  markers: Marker[],
  size: { width: number; height: number },
  prevTilt: number[] | null = null,
  scheme: StickerScheme = "aruco54",
  o: FaceOptions = DEFAULT_FACE,
  frontAlways = false,
): FacesResult {
  // ステッカーの ID のみ・写った色が ID の色と合うもの。54 種類の符号で同じ ID が 2 つあれば大きい方
  const coded: Coded[] = [];
  const byId = new Map<number, Coded>();
  const checked = scheme === "unique54" ? frameColorFilter(markers.filter((m) => decode(scheme, m.id)).map((m) => ({ ...m, face: decode(scheme, m.id)!.face }))) : markers;
  // 12 種類: 1 枚ずつの判定で取り違えの相手の色に見えても、同じフレームの同じ色の仲間にごく近ければ使う
  // （暖かい照明で薄い緑が「白」と判定され、白のセンターの読み違いとして捨てられていた）
  const supported = scheme === "aruco12" ? supportedByFrame(markers.flatMap((m) => (decode(scheme, m.id) ? [{ m, face: decode(scheme, m.id)!.face }] : []))) : new Set<Marker>();
  for (const m of checked) {
    const dec = decode(scheme, m.id);
    if (!dec || (!colorConsistent(scheme, m.id, m.rgb) && !supported.has(m))) continue;
    const c: Coded = { ...m, dec };
    if (dec.sticker < 0) {
      coded.push(c);
      continue;
    }
    const p = byId.get(dec.sticker);
    if (!p || m.side > p.side) byId.set(dec.sticker, c);
  }
  coded.push(...byId.values());
  let pool: Marker[] = coded.sort((a, b) => b.side - a.side);
  const faces: NonNullable<ReturnType<typeof toFace>>[] = [];
  while (pool.length) {
    const ref = pool[0];
    const g = gatherGroup(ref, pool, o);
    const used = new Set(g ? [...g.cells.values()].map((c) => c.m) : [ref]);
    used.add(ref);
    pool = pool.filter((m) => !used.has(m));
    if (!g) continue;
    const face = toFace(g, size);
    if (face) faces.push(face);
  }
  // 1 列・1 枚の面（partial）は、3×3 の面（なければそれ同士）で決めたキューブの傾きに合うときだけ使う
  const fullFaces = faces.filter((f) => !f.partial);
  const partials = faces.filter((f) => f.partial);
  if (fullFaces.length) faces.splice(0, faces.length, ...fullFaces);
  else partials.length = 0;
  if (!faces.length) return { faces: [], tilt: prevTilt };

  // 面の向き（法線）でカメラフレームの面に割り当てる。上面だけが見えているときに、それを正面と決めつけない。
  // 直前の傾きは使わない（キューブを回して別の面を見せる間に傾きの推定が狂うと、それで正面を取り違え、
  // 取り違えた傾きをまた引き継いで抜け出せなくなった）。
  // 2 つの面が同じ向きを取り合ったら（斜め 45° から見たとき）、より合う方から順に決める
  const pairs: { f: number; slot: number; score: number }[] = [];
  faces.forEach((f, fi) => SLOT_NORMALS.forEach((n, slot) => pairs.push({ f: fi, slot, score: dot3(n, f.normal) })));
  pairs.sort((a, b) => b.score - a.score);
  const taken = new Map<number, number>();
  const done = new Set<number>();
  for (const p of pairs) {
    if (done.has(p.f) || taken.has(p.slot) || p.score < 0.3) continue;
    taken.set(p.slot, p.f);
    done.add(p.f);
  }
  // frontAlways（ライブ）: 正面に割り当たる面がない（角を向けて上・横だけが見えている）ときは、いちばんカメラを向いた面を正面にし、
  // 他の面はそれに対して割り当て直す。普通のステッカーの認識と同じく正面のあるフレームにそろえると、キューブ全体を回している間も
  // 観測と 3D の向きが途切れない（実物の動画で、正面のないフレームを捨てて 3D の動きが止まっては飛んでいた）
  if (frontAlways && !taken.has(2)) {
    const front = faces.reduce((b, f, fi) => (f.normal[2] > faces[b].normal[2] ? fi : b), 0);
    const E0 = cubeTilt([{ a: SLOT_NORMALS[2], n: faces[front].normal }], null);
    taken.clear();
    taken.set(2, front);
    const rest: { f: number; slot: number; score: number }[] = [];
    faces.forEach((f, fi) => {
      if (fi === front) return;
      // E0⁻¹ n = E0ᵀ n: 正面の向きにそろえたときの法線
      const a: V3 = [0, 1, 2].map((c) => E0[c] * f.normal[0] + E0[3 + c] * f.normal[1] + E0[6 + c] * f.normal[2]) as V3;
      SLOT_NORMALS.forEach((n, slot) => slot !== 2 && rest.push({ f: fi, slot, score: dot3(n, a) }));
    });
    rest.sort((a, b) => b.score - a.score);
    const used = new Set<number>([front]);
    for (const p of rest) {
      if (used.has(p.f) || taken.has(p.slot) || p.score < 0.5) continue;
      taken.set(p.slot, p.f);
      used.add(p.f);
    }
  }
  // キューブの傾き: 割り当てた面の法線が、カメラフレームの面の法線を回したものになる回転。
  // 事前分布は直前の傾き（なければ傾きなし）。直前の傾きがいまの面の法線と合わない（持ち替えた・推定が狂っていた）ときは使わない
  const assigned = [...taken.entries()].map(([slot, fi]) => ({ a: SLOT_NORMALS[slot], n: faces[fi].normal }));
  const prior = prevTilt && assigned.every((p) => dot3(rot3(prevTilt, p.a), p.n) > 0.8) ? prevTilt : null;
  const E = cubeTilt(assigned, prior);
  // 1 列・1 枚の面: 傾きを戻した法線が、空いているカメラフレームの面の向きにほぼ一致するときだけ（約 25° 以内）。
  // 回している途中の層の側面は、回し始めと回し終わりの近く以外は外れる。回し終わりの近くなら、回った先の面に割り当たる
  for (const p of partials) {
    const a = [0, 1, 2].map((c) => E[c] * p.normal[0] + E[3 + c] * p.normal[1] + E[6 + c] * p.normal[2]) as V3;
    let best = -1;
    let score = 0.9;
    SLOT_NORMALS.forEach((n, slot) => {
      if (!taken.has(slot) && dot3(n, a) > score) {
        score = dot3(n, a);
        best = slot;
      }
    });
    if (best < 0) continue;
    faces.push(p);
    taken.set(best, faces.length - 1);
  }
  const pitch = median(faces.filter((f) => !f.partial && f.g.pitch).map((f) => f.g.pitch)) || DEFAULT_PITCH;
  const out: VisibleFace[] = [];
  for (const [slot, fi] of [...taken.entries()].sort((a, b) => a[0] - b[0])) {
    const f = faces[fi];
    const v = layout(f.g.pitch ? f : { ...f, g: { ...f.g, pitch } }, slot, E);
    if (v) out.push(f.partial ? { slot, ...v, partial: true } : { slot, ...v });
  }
  return { faces: out, tilt: E };
}

type V3 = [number, number, number];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// カメラフレームの面の外向き法線（+x 右・+y 上・+z カメラ側）。背面（5）は見えない
const SLOT_NORMALS: V3[] = [
  [0, 1, 0],
  [1, 0, 0],
  [0, 0, 1],
  [0, -1, 0],
  [-1, 0, 0],
];

// 格子の平面の向き: 射影変換を K [r1 r2 t] に分解する（焦点距離は画像の長辺の 0.8 倍を仮定）。
// r1・r2 = 基準の座標の +u・+v の 3D の向き、normal = 外向きの法線（すべてカメラフレーム）
function planeFrame(G: Mat3, size: { width: number; height: number }): { r1: V3; r2: V3; normal: V3 } {
  const f = defaultFocal(size.width, size.height);
  const cx = size.width / 2;
  const cy = size.height / 2;
  const col = (k: number): V3 => [(G[k] - cx * G[6 + k]) / f, (G[3 + k] - cy * G[6 + k]) / f, G[6 + k]];
  const unit = (v: V3): V3 => {
    const n = Math.hypot(...v) || 1;
    return [v[0] / n, v[1] / n, v[2] / n];
  };
  // 射影変換の符号は決まらないので、平面がカメラの前（奥）にある向きにそろえる
  const sign = col(2)[2] < 0 ? -1 : 1;
  // 画像処理の座標（x 右・y 下・z 奥）→ カメラフレーム（x 右・y 上・z 手前）
  const flip = (v: V3): V3 => [v[0] * sign, -v[1] * sign, -v[2] * sign];
  const r1 = unit(flip(col(0)));
  const r2 = unit(flip(col(1)));
  // 外から見て u が右・v が下なので、外向きの法線は r2 × r1
  let normal = unit([r2[1] * r1[2] - r2[2] * r1[1], r2[2] * r1[0] - r2[0] * r1[2], r2[0] * r1[1] - r2[1] * r1[0]]);
  if (normal[2] < 0) normal = [-normal[0], -normal[1], -normal[2]]; // 見えている面はカメラを向く
  return { r1, r2, normal };
}

// Σ w n aᵀ に最も近い回転（極分解。R ← (R + R⁻ᵀ) / 2 の反復）。a = カメラフレームの面の法線、n = 実際の法線
function cubeTilt(pairs: { a: V3; n: V3 }[], prior: number[] | null): number[] {
  const w = prior ? 0.6 : 0.15;
  const M = (prior ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]).map((v) => v * w);
  for (const { a, n } of pairs) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M[r * 3 + c] += n[r] * a[c];
  let R = M;
  for (let it = 0; it < 30; it++) {
    const inv = invert3(R);
    if (!inv) break;
    // R⁻ᵀ
    const it_ = [inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]];
    R = R.map((v, k) => (v + it_[k]) / 2);
  }
  return R;
}

function invert3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
}

const rot3 = (R: number[], v: V3): V3 => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];

// 位置の決まる格子だけを面にする: センターがあるか、3×3 に広がっている。回している途中の層の 1 列などは外す
// （向きの割り当てとキューブの傾きを狂わせる）
function toFace(g: Group, size: { width: number; height: number }) {
  const cells = [...g.cells.values()];
  const span = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
  // 位置が決まること: センターがある・3×3 に広がっている・ステッカーごとに位置と向きが決まった符号（ID と向きから真ん中が分かる）で
  // 2 行 2 列以上に広がっている（一直線の 3 枚は回している途中の層の側面のことが多いので、ID だけでは面にしない）
  const center = cells.some((c) => (c.m as Coded).dec.center);
  const full = span(cells.map((c) => c.i)) === 2 && span(cells.map((c) => c.j)) === 2;
  const hasId = cells.some((c) => (c.m as Coded).dec.sticker >= 0);
  const spread2d = new Set(cells.map((c) => c.i)).size >= 2 && new Set(cells.map((c) => c.j)).size >= 2;
  if (g.pitch && (center || full || (hasId && spread2d))) return { g, ...planeFrame(g.G, size), count: cells.length, partial: false };
  // 1 列（1×3・1×2）か 1 枚: ID と向きで位置が決まる符号、または 12 種類のセンター 1 枚（真ん中のマスの色 = その面の色）
  if (hasId || (center && cells.length === 1)) return { g, ...planeFrame(g.G, size), count: cells.length, partial: true };
  return null;
}

// 面のセルの並び（カメラフレームの規約: src/cube/model.ts の ROWDIR・COLDIR をカメラフレームに当てはめたもの）。
// 行の向きを 3D で、傾けたキューブでのその面の ROWDIR に最も近い軸にし（画像の上の角度では、潰れて写る上面の向きを誤る。
// カメラの軸のままでは、見下ろしたキューブの上面の向きを誤る）、センター（なければ 3×3 の広がり）で位置を決める
function layout(face: NonNullable<ReturnType<typeof toFace>>, slot: number, E: number[]): Omit<VisibleFace, "slot"> | null {
  const { g, r1, r2 } = face;
  const want = rot3(E, ROWDIR[slot] as V3);
  const neg = (v: V3): V3 => [-v[0], -v[1], -v[2]];
  // 行の向きの候補: +v, +u, -v, -u（列は行から 90° で決まる。外から見ているので鏡像にはならない）
  // map: 基準の座標 (i, j) → (行, 列)、inv: その逆
  const options: { row: V3; map: (i: number, j: number) => [number, number]; inv: (r: number, c: number) => [number, number] }[] = [
    { row: r2, map: (i, j) => [j, i], inv: (r, c) => [c, r] },
    { row: r1, map: (i, j) => [i, -j], inv: (r, c) => [r, -c] },
    { row: neg(r2), map: (i, j) => [-j, -i], inv: (r, c) => [-c, -r] },
    { row: neg(r1), map: (i, j) => [-i, j], inv: (r, c) => [-r, c] },
  ];
  const best = options.reduce((a, b) => (dot3(b.row, want) > dot3(a.row, want) ? b : a));
  let cells = [...g.cells.values()];
  // ステッカーごとに位置と向きが決まった符号: 各マーカーの ID と向きから真ん中の位置を出し、多数決で決める。
  // 食い違うマーカー（同じ色の別の ID への読み違い・別の面）は外す
  let voted: [number, number] | null = null;
  const votes = cells.filter((c) => (c.m as Coded).dec.sticker >= 0).map((c) => ({ c, at: centerVote(c) }));
  if (votes.length) {
    const count = new Map<string, number>();
    for (const v of votes) count.set(`${v.at[0]},${v.at[1]}`, (count.get(`${v.at[0]},${v.at[1]}`) ?? 0) + 1);
    const inside = (k: string) => {
      const [ci, cj] = k.split(",").map(Number);
      return cells.filter((c) => Math.abs(c.i - ci) <= 1 && Math.abs(c.j - cj) <= 1).length;
    };
    const ranked = [...count.keys()].sort((a, b) => count.get(b)! - count.get(a)! || inside(b) - inside(a));
    const key = ranked[0];
    // 票も広がりも同じ候補が 2 つ（読み違いと本物が 1 枚ずつなど）なら、どちらが真ん中か決められないので面にしない（決めつけない）
    if (ranked.length > 1 && count.get(ranked[1]) === count.get(key) && inside(ranked[1]) === inside(key)) return null;
    voted = key.split(",").map(Number) as [number, number];
    const bad = new Set(votes.filter((v) => `${v.at[0]},${v.at[1]}` !== key).map((v) => v.c));
    cells = cells.filter((c) => !bad.has(c));
  }
  const rc = cells.map((c) => ({ c, rc: best.map(c.i, c.j) }));
  const center = rc.find((x) => (x.c.m as Coded).dec.center);
  let dr: number;
  let dc: number;
  if (voted) {
    const [r, c] = best.map(voted[0], voted[1]);
    dr = 1 - r;
    dc = 1 - c;
  } else if (center) {
    dr = 1 - center.rc[0];
    dc = 1 - center.rc[1];
  } else {
    const rows = rc.map((x) => x.rc[0]);
    const cols = rc.map((x) => x.rc[1]);
    if (Math.max(...rows) - Math.min(...rows) !== 2 || Math.max(...cols) - Math.min(...cols) !== 2) return null;
    dr = -Math.min(...rows);
    dc = -Math.min(...cols);
  }
  const ids = new Array(9).fill(-1);
  const colors = new Array(9).fill(-1);
  const conf = new Array(9).fill(1);
  for (const x of rc) {
    const r = x.rc[0] + dr;
    const c = x.rc[1] + dc;
    if (r < 0 || r > 2 || c < 0 || c > 2) continue;
    const dec = (x.c.m as Coded).dec;
    // センターの符号が真ん中以外にある（同じ色のセンターとそれ以外の取り違え）なら、色は同じなのでそのまま使う
    colors[r * 3 + c] = dec.face;
    ids[r * 3 + c] = dec.sticker;
    conf[r * 3 + c] = readConfidence(x.c.m.fit);
  }
  // セルの角（r, c は 0.5 刻み）の画像座標
  const corner = (r: number, c: number): Pt => {
    const [i, j] = best.inv(r - dr, c - dc);
    return applyH(g.G, i * g.pitch, j * g.pitch);
  };
  const outline: Pt[] = [corner(-0.5, -0.5), corner(-0.5, 2.5), corner(2.5, 2.5), corner(2.5, -0.5)];
  const H = fitHomography(
    [
      [0, 0],
      [3, 0],
      [3, 3],
      [0, 3],
    ],
    outline,
  );
  if (!H) return null;
  return { colors, ids, conf, outline, H };
}

// 読みの確からしさ: マスの中心の明暗が符号どおりの割合（fit）から。合成画像（54 種類・指・ぶれ・180 場面）で、誤読 22 枚のうち
// 20 枚が fit 0.95 未満、正しい読み 1,859 枚の 93% が 0.95 以上だった（fit 0.85〜0.9 の誤読は 28%・0.9〜0.95 は 10%・それ以上 0.1%）。
// 確からしさの低い読みは観測のコストを下げ、1 枚の誤読で手を足さないようにする（決めつけない）
export function readConfidence(fit: number): number {
  return fit < 0.9 ? 0.4 : fit < 0.95 ? 0.7 : 1;
}

// 1 枚だけの面の格子の間隔（マーカーの辺に対する比）: 同じフレームの 3×3 の面がなければ、18mm のステッカーを 19mm 間隔で貼ったとき
const DEFAULT_PITCH = 1.3;

// マーカーの ID（揃った状態の位置）と向き（基準の座標で 90° 単位）から、その面の真ん中のセル（基準の座標の i, j）
function centerVote(c: { m: Marker; rot: number; i: number; j: number }): [number, number] {
  const [x, y] = centerOffset((c.m as Coded).dec.sticker);
  // マーカーの右・下の軸を基準の座標へ（rot = マーカーの上辺の向き。基準の座標は右 +i・下 +j）
  const v: [number, number] = [
    [x, y],
    [-y, x],
    [-x, -y],
    [y, -x],
  ][c.rot] as [number, number];
  return [c.i + v[0], c.j + v[1]];
}

// ---- 観測と復号 ----

export interface CubeFrame {
  t: number; // 実時間（ms）
  faces: VisibleFace[];
}

const MISMATCH = 1.5; // 1 枚の矛盾のコスト（色の観測と同じ。src/track/colorModel.ts）
const ID_MISMATCH = 1.0; // 色は合うのに別のステッカー（src/track/observer.ts の idMismatchCost と同じ）

// 1 フレームの読み: カメラフレームの面ごとの 9 セルの色（-1 = 読めない）と、読んだステッカー（54 種類の符号のとき。-1 = 不明）。
// 3 マス以上読めた面だけ
interface Cells {
  c: Int8Array;
  id: Int16Array;
  w: Float32Array; // 読みの確からしさ（合わせたフレームのうち最大）
}
type Reading = Map<number, Cells>;

function readingOf(faces: VisibleFace[]): Reading {
  const r: Reading = new Map();
  for (const f of faces) {
    if (f.colors.filter((c) => c >= 0).length < 3) continue;
    r.set(f.slot, { c: Int8Array.from(f.colors), id: Int16Array.from(f.ids), w: Float32Array.from(f.conf) });
  }
  return r;
}

// 両方で読めたセルの色（かステッカー）が食い違うか。同じ色の別のステッカーは、色だけでは見えない手が起きたしるし
function conflicts(a: Reading, b: Reading): boolean {
  for (const [slot, x] of a) {
    const y = b.get(slot);
    if (!y) continue;
    for (let c = 0; c < 9; c++) {
      if (x.c[c] >= 0 && y.c[c] >= 0 && x.c[c] !== y.c[c]) return true;
      if (x.id[c] >= 0 && y.id[c] >= 0 && x.id[c] !== y.id[c]) return true;
    }
  }
  return false;
}

// a で読めて ref で読めていないセルの数
function newCells(a: Reading, ref: Reading): number {
  let n = 0;
  for (const [slot, x] of a) {
    const y = ref.get(slot);
    for (let c = 0; c < 9; c++) if (x.c[c] >= 0 && (!y || y.c[c] < 0)) n++;
  }
  return n;
}

function mergeInto(into: Reading, b: Reading): void {
  for (const [slot, y] of b) {
    const x = into.get(slot);
    if (!x) into.set(slot, { c: Int8Array.from(y.c), id: Int16Array.from(y.id), w: Float32Array.from(y.w) });
    else
      for (let c = 0; c < 9; c++) {
        if (x.c[c] < 0) x.c[c] = y.c[c];
        if (x.id[c] < 0) x.id[c] = y.id[c];
        if (y.c[c] >= 0) x.w[c] = Math.max(x.w[c], y.w[c]);
      }
  }
}

const cloneReading = (r: Reading): Reading => new Map([...r].map(([k, v]) => [k, { c: Int8Array.from(v.c), id: Int16Array.from(v.id), w: Float32Array.from(v.w) }]));

// 見え方が stableFrames 枚続いたら観測を出す。斜めの面の小さいマーカーはフレームごとに読めたり読めなかったりするので、
// まったく同じ読みが続くことは求めない: 読めたセルどうしが食い違わないフレームは同じ見え方として読みを合わせる。
// 前の観測と食い違う（手が起きた）か、新しく 3 マス以上読めたときに出す
export function buildObservations(frames: CubeFrame[], stableFrames = 3): Observation[] {
  const out: Observation[] = [];
  let last: Reading | null = null;
  let lastSeen = frames.length ? frames[0].t : 0;
  let run: { reading: Reading; start: number; count: number; done: boolean } | null = null;
  for (let i = 0; i < frames.length; i++) {
    const r = readingOf(frames[i].faces);
    if (!r.size) continue; // 何も読めないフレーム（ぶれ・手で隠れた）は見え方を区切らない
    const t = frames[i].t;
    if (last && !conflicts(r, last)) lastSeen = t;
    if (!run || conflicts(r, run.reading)) run = { reading: cloneReading(r), start: i, count: 0, done: false };
    else mergeInto(run.reading, r);
    run.count++;
    if (run.done || run.count < stableFrames) continue;
    run.done = true;
    if (last && !conflicts(run.reading, last) && newCells(run.reading, last) < 3) continue;
    const faces: FaceObservation[] = [...run.reading].map(([slot, { c: colors, id, w }]) => {
      const cost = new Float32Array(54);
      const labels = Int8Array.from(colors);
      // 確からしさの低い読み（readConfidence）はコストを下げる
      colors.forEach((color, cell) => {
        if (color < 0) return;
        for (let c = 0; c < 6; c++) cost[cell * 6 + c] = c === color ? 0 : MISMATCH * w[cell];
      });
      // 読んだステッカー（色が合うものだけ）。同じ色の別のステッカーのコストは 1 手と同じ
      const ids = Int16Array.from(id, (v, cell) => (v >= 0 && Math.floor(v / 9) === colors[cell] ? v : -1));
      if (!ids.some((v) => v >= 0)) return { slot, cost, labels };
      return { slot, cost, labels, ids, idCost: Float32Array.from(w, (x) => ID_MISMATCH * x) };
    });
    const t0 = frames[run.start].t;
    out.push({ t: t0, tPrevEnd: Math.min(lastSeen, t0), faces: faces.sort((a, b) => a.slot - b.slot) });
    last = cloneReading(run.reading);
    lastSeen = t;
  }
  return out;
}

// 手ごとの回し始め・回し終わりを、フレームごとの面から決め直す（3D を実際の速さと間で動かすため）。
// 回している途中の層は面として組み立てないので、観測の区切りだけでは回し始めと回し終わりがほぼ同じ時刻になる。
// 回した層の側面のマス（回している面そのものは格子ごと回るので使わない）のうち、回す前と後で色が変わるものを見て、
// 回す前の色が最後にそろって見えたフレームと、回した後の色が最初にそろって見えたフレームの間を回していた時間とする
export function turnTimes(frames: CubeFrame[], moves: DecodedMove[]): DecodedMove[] {
  let state = solvedState();
  let k = 0; // 探し始めるフレーム（前の手の回し終わり）
  return moves.map((m) => {
    const before = state;
    const after = applyMove(state, m.move);
    state = after;
    const n = NORMAL[moveFace(m.move)];
    // このフレームが、回す前（-1）・回した後（1）のどちらにそろって見えるか（どちらでもなければ 0）
    const side = (f: CubeFrame): number => {
      let pre = 0;
      let post = 0;
      let other = 0;
      for (const face of f.faces) {
        face.colors.forEach((c, cell) => {
          if (c < 0) return;
          const fl = VIEW[(m.orient * 6 + face.slot) * 9 + cell];
          if (before[fl] === after[fl]) return;
          const g = faceletGeometry(fl);
          if (g.pos[0] * n[0] + g.pos[1] * n[1] + g.pos[2] * n[2] !== 1 || g.normal.every((v, i) => v === n[i])) return;
          if (c === before[fl]) pre++;
          else if (c === after[fl]) post++;
          else other++;
        });
      }
      if (pre >= 2 && !post && !other) return -1;
      if (post >= 2 && !pre && !other) return 1;
      return 0;
    };
    let iT = k;
    while (iT + 1 < frames.length && frames[iT + 1].t <= m.t) iT++;
    let end = iT;
    while (end + 1 < frames.length && frames[end + 1].t <= m.t + 400) end++;
    const sides = frames.slice(k, end + 1).map(side);
    const at = (i: number) => sides[i - k] ?? 0;
    // 回し終わり: 回した後の色が 2 フレーム続けて見えた最初のフレーム（回している途中にたまたまそろって見えたものを除く）
    let firstPost = -1;
    for (let i = k + 1; i <= end; i++) if (at(i) === 1 && (i === end || at(i + 1) === 1)) {
      firstPost = i;
      break;
    }
    if (firstPost < 0) return m;
    // 回し始め: その前で、回す前の色が 2 フレーム続けて見えた最後のフレームの次（なければ 1 フレームだけのものでも）
    let lastPre = -1;
    for (let i = firstPost - 1; i >= k; i--) if (at(i) === -1 && (i === k || at(i - 1) === -1)) {
      lastPre = i;
      break;
    }
    if (lastPre < 0) for (let i = firstPost - 1; i >= k; i--) if (at(i) === -1) {
      lastPre = i;
      break;
    }
    if (lastPre < 0) return m;
    k = firstPost;
    const t0 = (frames[lastPre].t + frames[lastPre + 1].t) / 2;
    const t = (frames[firstPost - 1].t + frames[firstPost].t) / 2;
    return { ...m, t0, t };
  });
}

// フレームごとのマーカーから面を組み立てる（傾きを次のフレームへ引き継ぐ）
export function facesOverTime(frames: { t: number; markers: Marker[] }[], size: { width: number; height: number }, scheme: StickerScheme = "aruco54"): CubeFrame[] {
  let tilt: number[] | null = null;
  return frames.map((f) => {
    const r = reconstructFaces(f.markers, size, tilt, scheme);
    tilt = r.tilt;
    return { t: f.t, faces: r.faces };
  });
}

export interface CubeResult {
  moves: DecodedMove[]; // まとめた後（simplifyMoves）
  raw: DecodedMove[];
  method: string;
  reachedEnd: boolean;
  observations: number;
  framesWithFace: number;
  frames: number;
  ms: number;
}

// 揃った状態から始めたとして手順を推定する（endSolved なら最後も揃っている）
export function decodeCube(frames: CubeFrame[], endSolved: boolean, stableFrames = 3): CubeResult {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const obs = buildObservations(frames, stableFrames);
  const lastT = frames.length ? frames[frames.length - 1].t : 0;
  const r = decodeOffline(obs, solvedState(), endSolved ? solvedState() : null, lastT, DEFAULT_OFFLINE);
  const raw = turnTimes(frames, r.moves);
  return {
    moves: simplifyMoves(raw),
    raw,
    method: r.method,
    reachedEnd: r.reachedEnd,
    observations: obs.length,
    framesWithFace: frames.filter((f) => f.faces.length).length,
    frames: frames.length,
    ms: (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0,
  };
}

// 回転途中の形状認識: 層を回している途中（キューブが立方体の形でない）フレームでも、読めたマーカーをすべて使い、
// 回していない 2 層（本体）の姿勢と、回している層・その角度を求める。各マーカーの 3D の位置・向き（キューブの座標）も出す。
//
// 1. 本体: 組み立てた面（回している途中の層は格子に合わないので外れる: reconstructFaces）から PnP で姿勢を求める（estimatePose）
// 2. 各マーカーを、本体のマスの位置（射影）と向きで照らす。合うものは本体
// 3. 合わないマーカーを、6 つの外側の層 × 回す角度 θ の仮説で照らす: 層のマスを軸のまわりに θ 回した位置・向きに、
//    マーカーの中心と法線が合うか。いちばん合う層と θ を選ぶ（粗く探してから細かく）
// 形だけからは 90° ごとの区別がつかない（θ は -45°〜45°）。フレームをまたいで θ をつなぐと（unwrapTurn）、回した向きと量が分かる。
// DOM もカメラも知らない
import { NORMAL, type Vec3 } from "../cube/model";
import { type Pt, fitHomography } from "../vision/homography";
import { type Pose, defaultFocal, estimatePose, latticePoint } from "../vision/pose";
import type { VisibleFace } from "./cube";
import type { Marker } from "./detect";

export interface TurnShape {
  axis: number; // 回している軸（カメラフレームに揃ったキューブの x 右・y 上・z 手前 = 0, 1, 2）
  layer: number; // 軸の正の側の層なら 1、負の側なら -1
  slot: number; // その層の外側の面（カメラフレームの面: 0 上 / 1 右 / 2 正面 / 3 下 / 4 左 / 5 背面）
  angle: number; // 軸の正の向きのまわりに右手で回した角度（ラジアン、-π/4〜π/4。90° ごとの区別はつかない）
  markers: number; // 回している層に合ったマーカーの数
  err: number; // 合ったマーカーの中心のずれの平均（マスの間隔に対する割合）
}

export interface PlacedMarker {
  id: number;
  center: Vec3; // キューブの座標（カメラフレームに揃ったキューブ、マス = 1、面は ±1.5）
  normal: Vec3;
  layer: boolean; // 回している層のマーカー
  err: number; // 予測した位置との中心のずれ（マスの間隔に対する割合）
}

export interface TurnResult {
  pose: Pose | null;
  turn: TurnShape | null;
  placed: PlacedMarker[];
  unexplained: number; // 本体にも回している層にも合わなかったマーカー
}

type V = number[];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const rotate = (R: number[], v: V): Vec3 => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
const rotateT = (R: number[], v: V): Vec3 => [R[0] * v[0] + R[3] * v[1] + R[6] * v[2], R[1] * v[0] + R[4] * v[1] + R[7] * v[2], R[2] * v[0] + R[5] * v[1] + R[8] * v[2]];

// 軸 axis（0, 1, 2）のまわりに θ（右手）
function axisRot(axis: number, th: number, v: V): Vec3 {
  const c = Math.cos(th);
  const s = Math.sin(th);
  if (axis === 0) return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]];
  if (axis === 1) return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
  return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
}

// 54 マスの中心と法線（カメラフレームに揃ったキューブの座標。slot は U R F D L B の並びの面）
const STICKERS: { pos: Vec3; normal: Vec3 }[] = Array.from({ length: 54 }, (_, i) => {
  const slot = Math.floor(i / 9);
  const cell = i % 9;
  return { pos: latticePoint(slot, (cell % 3) + 0.5, Math.floor(cell / 3) + 0.5), normal: NORMAL[slot] };
});

// マーカーの 4 隅の射影変換を分解した、マーカーの平面の外向きの法線（カメラフレーム、x 右・y 上・z 手前）
export function markerNormal(m: Marker, size: { width: number; height: number }, focal = defaultFocal(size.width, size.height)): Vec3 | null {
  const pts: Pt[] = [0, 1, 2, 3].map((i) => [m.corners[i * 2], m.corners[i * 2 + 1]]);
  const G = fitHomography(
    [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
    ],
    pts,
  );
  if (!G) return null;
  const cx = size.width / 2;
  const cy = size.height / 2;
  const col = (k: number) => [(G[k] - cx * G[6 + k]) / focal, (G[3 + k] - cy * G[6 + k]) / focal, G[6 + k]];
  const sign = col(2)[2] < 0 ? -1 : 1;
  const flip = (v: V): Vec3 => [v[0] * sign, -v[1] * sign, -v[2] * sign];
  const unit = (v: V): Vec3 => {
    const n = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / n, v[1] / n, v[2] / n];
  };
  const r1 = unit(flip(col(0)));
  const r2 = unit(flip(col(1)));
  let n = unit([r2[1] * r1[2] - r2[2] * r1[1], r2[2] * r1[0] - r2[0] * r1[2], r2[0] * r1[1] - r2[1] * r1[0]]);
  if (n[2] < 0) n = [-n[0], -n[1], -n[2]];
  return n;
}

const centerOf = (m: Marker): Pt => [(m.corners[0] + m.corners[2] + m.corners[4] + m.corners[6]) / 4, (m.corners[1] + m.corners[3] + m.corners[5] + m.corners[7]) / 4];

export interface TurnOptions {
  bodyTol: number; // 本体のマスとみなす中心のずれ（マスの間隔に対する割合）
  matchTol: number; // 回している層のマスと合うとみなすずれ
  gain: number; // 回したマスの方が、回していないマスよりこれだけ合うときだけ「回っている」と数える（軸の上のマスは回しても動かない）
  normalTol: number; // 法線の向きの一致（内積の下限）
  minAngle: number; // これより小さい角度は回していない（本体）とみなす（ラジアン）
  minGain: number; // 回しているとしたときのずれの合計が、回していないとしたときよりこれだけ小さいこと
  anchorTol: number; // 本体の姿勢を選ぶとき、マスに合うとみなすずれ（正しい姿勢ではずれが小さいので、bodyTol より厳しく）
  pairTol: number; // 回している層に合ったマーカーが 2 枚だけのとき、ずれの平均がこれ以下であること
}

export const DEFAULT_TURN: TurnOptions = { bodyTol: 0.25, matchTol: 0.35, gain: 0.1, normalTol: 0.75, minAngle: (6 * Math.PI) / 180, minGain: 0.3, anchorTol: 0.12, pairTol: 0.06 };

type Obs = { m: Marker; c: Pt; n: Vec3 | null };

// 姿勢 pose のもとで、マス（STICKERS の番号）のうち use に入るものを軸 axis のまわりに th 回したとき、マーカー x に最も合うマスとずれ
function nearest(ctx: Ctx, x: Obs, use: (i: number) => boolean, axis: number, th: number, o: TurnOptions): { s: number; d: number } {
  let bd = Infinity;
  let bs = -1;
  for (let i = 0; i < 54; i++) {
    if (!use(i)) continue;
    const st = STICKERS[i];
    const q = th ? axisRot(axis, th, st.pos) : st.pos;
    const nn = th ? axisRot(axis, th, st.normal) : st.normal;
    if (ctx.facing(q, nn) <= 0.02) continue;
    if (x.n && dot(rotateT(ctx.pose.R, x.n), nn) < o.normalTol) continue;
    const p = ctx.project(q);
    if (!p) continue;
    const d = Math.hypot(p[0] - x.c[0], p[1] - x.c[1]) / ctx.pitch;
    if (d < bd) {
      bd = d;
      bs = i;
    }
  }
  return { s: bs, d: bd };
}

// マーカー x と 54 マスそれぞれ（回していない位置）のずれ（向きが合わない・見えないマスは Infinity）
function distances(ctx: Ctx, x: Obs, o: TurnOptions): number[] {
  const n = x.n ? rotateT(ctx.pose.R, x.n) : null;
  return STICKERS.map((st) => {
    if (ctx.facing(st.pos, st.normal) <= 0.02) return Infinity;
    if (n && dot(n, st.normal) < o.normalTol) return Infinity;
    const p = ctx.project(st.pos);
    return p ? Math.hypot(p[0] - x.c[0], p[1] - x.c[1]) / ctx.pitch : Infinity;
  });
}

interface Ctx {
  pose: Pose;
  pitch: number;
  project: (q: V) => Pt | null;
  facing: (q: V, n: V) => number;
}

function context(pose: Pose, size: { width: number; height: number }, focal: number): Ctx | null {
  const project = (q: V): Pt | null => {
    const p = rotate(pose.R, q).map((v, i) => v + pose.t[i]);
    if (p[2] >= -0.1) return null;
    return [size.width / 2 + (focal * p[0]) / -p[2], size.height / 2 - (focal * p[1]) / -p[2]];
  };
  // マスの間隔（px）: 正面の中心付近の 1 マス
  const a = project([0, 0, 1.5]);
  const b = project([1, 0, 1.5]);
  const pitch = a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
  if (!pitch) return null;
  // カメラへの向き: マスの中心からカメラ（原点）への向きと法線の内積
  const facing = (q: V, n: V) => {
    const p = rotate(pose.R, q).map((v, i) => v + pose.t[i]);
    return -dot(rotate(pose.R, n), p) / (Math.hypot(p[0], p[1], p[2]) || 1);
  };
  return { pose, pitch, project, facing };
}

// 本体の姿勢の候補: 面ごとの姿勢と全部の面の姿勢のうち、マスの位置・向きに合うマーカーがいちばん多いもの。
// 回している層の外側の面（R を回しているときの R の面）も、マーカーどうしはそろっているので面として組み立てられるが、格子が本体から
// 回っている。そこから求めた姿勢は、その層のマーカーにしか合わない（層の外側の面がいちばん大きく見えているときは、層の方が
// 「本体」に選ばれることがある。そのときは残りの 2 層が回って見えるので、下の仮説で裏返す）
function anchorPose(faces: VisibleFace[], obs: Obs[], size: { width: number; height: number }, focal: number, o: TurnOptions, prev: Pose | null): Ctx | null {
  const full = faces.filter((f) => !f.partial);
  const est = (fs: VisibleFace[]) => (fs.length ? estimatePose(fs.map((f) => ({ slot: f.slot, H: f.H, rot: 0 })), size.width, size.height, focal) : null);
  let best: { ctx: Ctx; inliers: number } | null = null;
  // 全部の面・1 つ外した面（3 面以上のとき）・面 1 つずつ・直前のフレームの本体の姿勢
  const sets = [full, ...(full.length > 2 ? full.map((f) => full.filter((g) => g !== f)) : []), ...(full.length > 1 ? full.map((f) => [f]) : [])];
  for (const p of [...sets.map(est), prev]) {
    const ctx = p && context(p, size, focal);
    if (!ctx) continue;
    const inliers = obs.filter((x) => nearest(ctx, x, () => true, 0, 0, o).d < o.anchorTol).length;
    if (!best || inliers > best.inliers || (inliers === best.inliers && p.err < best.ctx.pose.err)) best = { ctx, inliers };
  }
  return best?.ctx ?? null;
}

// prev: 直前のフレームの本体の姿勢（あれば候補に入れ、層の外側の面と残りの 2 層のどちらが本体かで迷うとき、近い方を選ぶ）
export function recognizeTurn(markers: Marker[], faces: VisibleFace[], size: { width: number; height: number }, prev: Pose | null = null, o: TurnOptions = DEFAULT_TURN): TurnResult {
  const focal = defaultFocal(size.width, size.height);
  const obs: Obs[] = markers.map((m) => ({ m, c: centerOf(m), n: markerNormal(m, size, focal) }));
  const ctx = anchorPose(faces, obs, size, focal, o, prev);
  if (!ctx) return { pose: null, turn: null, placed: [], unexplained: markers.length };
  // 回していないときの、各マーカーと各マスのずれ（仮説ごとに使い回す）
  const still = obs.map((x) => distances(ctx, x, o));
  const rest = obs.filter((_, k) => Math.min(...still[k]) >= o.bodyTol).length;
  // 回していないマスより合いそうなマーカーが 2 枚なければ、回している層はない（止まっているフレームの大半はここで終わる）
  if (obs.filter((_, k) => Math.min(...still[k]) >= o.gain).length < 2) return { pose: ctx.pose, turn: null, placed: placeAll(ctx, obs, null, o), unexplained: rest };
  // 層 × 角度の仮説。moving: 回るマス（外側の 1 層、または残りの 2 層 = 姿勢を求めた方が回している層だったとき）。
  // すべてのマーカーを「回っていないマス」か「回ったマス」のどちらかで説明できるか（片方だけで照らすと、R の層と R・M の 2 層が同じ点になる）
  const score = (axis: number, layer: number, block: boolean, th: number) => {
    const use = (i: number) => (block ? STICKERS[i].pos[axis] * layer <= 0.1 : STICKERS[i].pos[axis] * layer >= 0.9);
    let cost = 0;
    let n = 0;
    let err = 0;
    obs.forEach((x, k) => {
      let ds = Infinity;
      for (let i = 0; i < 54; i++) if (!use(i) && still[k][i] < ds) ds = still[k][i];
      const dm = nearest(ctx, x, use, axis, th, o).d;
      if (dm < o.matchTol && dm < ds - o.gain) {
        n++;
        err += dm;
      }
      cost += Math.min(ds, dm, 0.6);
    });
    return { cost, n, err: n ? err / n : Infinity };
  };
  type Best = { axis: number; layer: number; block: boolean; th: number; cost: number; n: number; err: number };
  let best: Best | null = null;
  const STEP = (3 * Math.PI) / 180;
  for (let axis = 0; axis < 3; axis++)
      for (const layer of [-1, 1])
        for (const block of [false, true])
          for (let th = -Math.PI / 4 + STEP / 2; th < Math.PI / 4; th += STEP) {
            if (Math.abs(th) < o.minAngle) continue;
            const s = score(axis, layer, block, th);
            // 同じだけ合うなら（1 層と、それ以外の 2 層のどちらが回ったか見分けられない）、直前の本体の向きに近い方
            const tie = best && Math.abs(s.cost - best.cost) <= 1e-6;
            if (s.n >= 2 && (!best || s.cost < best.cost - 1e-6 || (tie && prev && bodyDiff(ctx.pose, axis, block ? th : 0, prev) < bodyDiff(ctx.pose, best.axis, best.block ? best.th : 0, prev))))
              best = { axis, layer, block, th, ...s };
          }
  if (best) {
    // 細かく（0.5°）
    const b0 = best;
    for (let th = b0.th - STEP; th <= b0.th + STEP; th += STEP / 6) {
      if (Math.abs(th) < o.minAngle || Math.abs(th) > Math.PI / 4) continue;
      const s = score(b0.axis, b0.layer, b0.block, th);
      if (s.n >= best.n && s.cost < best.cost) best = { ...b0, th, ...s };
    }
  }
  // 回していないとしたときより、はっきり合うときだけ（小さな角度の雑音で、回していない層を回っているとしない）
  const stillCost = obs.reduce((sum, _, k) => sum + Math.min(Math.min(...still[k]), 0.6), 0);
  if (best && best.cost > stillCost - o.minGain) best = null;
  // 2 枚だけで合うときは、ずれがごく小さいこと（ぶれて読めたマーカーが 2 枚だけ、たまたま逆向きの角度に合うことがある）
  if (best && best.n < 3 && best.err > o.pairTol) best = null;
  if (!best) return { pose: ctx.pose, turn: null, placed: placeAll(ctx, obs, null, o), unexplained: rest };
  // 残りの 2 層が回って見えた: 本体はその 2 層。姿勢を 2 層の側に直し、回している層（姿勢を求めた側）の角度は逆向き
  let body = ctx;
  let angle = best.th;
  if (best.block) {
    const Rt = [0, 1, 2].map((c) => axisRot(best!.axis, best!.th, [c === 0 ? 1 : 0, c === 1 ? 1 : 0, c === 2 ? 1 : 0]));
    // R_body = R · Rot(θ)（列 c = Rot(θ) e_c を R で回したもの）
    const R = ctx.pose.R;
    const cols = Rt.map((v) => rotate(R, v));
    const Rb = [cols[0][0], cols[1][0], cols[2][0], cols[0][1], cols[1][1], cols[2][1], cols[0][2], cols[1][2], cols[2][2]];
    body = context({ ...ctx.pose, R: Rb }, size, focal) ?? ctx;
    angle = -best.th;
  }
  const slot = [
    [4, 1],
    [3, 0],
    [5, 2],
  ][best.axis][best.layer > 0 ? 1 : 0];
  const turn: TurnShape = { axis: best.axis, layer: best.layer, slot, angle, markers: best.n, err: best.err };
  const placed = placeAll(body, obs, turn, o);
  return { pose: body.pose, turn, placed, unexplained: obs.length - placed.length };
}

// 本体の向き（姿勢を求めた側から軸のまわりに th 回したもの）と、直前の本体の向きの差（ラジアン）
function bodyDiff(pose: Pose, axis: number, th: number, prev: Pose): number {
  const cols = [0, 1, 2].map((c) => rotate(pose.R, axisRot(axis, th, [c === 0 ? 1 : 0, c === 1 ? 1 : 0, c === 2 ? 1 : 0])));
  const pc = [0, 1, 2].map((c) => [prev.R[c], prev.R[3 + c], prev.R[6 + c]]);
  const tr = cols.reduce((sum, v, c) => sum + dot(v, pc[c]), 0);
  return Math.acos(Math.min(1, Math.max(-1, (tr - 1) / 2)));
}

// 各マーカーを、本体のマスか回している層のマス（turn の角度で回した位置）のうち合う方に置く
function placeAll(ctx: Ctx, obs: Obs[], turn: TurnShape | null, o: TurnOptions): PlacedMarker[] {
  const out: PlacedMarker[] = [];
  for (const x of obs) {
    const inLayer = (i: number) => !!turn && STICKERS[i].pos[turn.axis] * turn.layer >= 0.9;
    const b = nearest(ctx, x, (i) => !inLayer(i), 0, 0, o);
    const l = turn ? nearest(ctx, x, inLayer, turn.axis, turn.angle, o) : { s: -1, d: Infinity };
    if (b.d < o.bodyTol && b.d <= l.d) out.push({ id: x.m.id, center: STICKERS[b.s].pos, normal: STICKERS[b.s].normal, layer: false, err: b.d });
    else if (turn && l.d < o.matchTol) out.push({ id: x.m.id, center: axisRot(turn.axis, turn.angle, STICKERS[l.s].pos), normal: axisRot(turn.axis, turn.angle, STICKERS[l.s].normal), layer: true, err: l.d });
  }
  return out;
}

// フレームごとの θ（-π/4〜π/4）をつないで、回し始めからの角度にする。同じ層を回している間、前のフレームから 45° 以上
// 跳んだら 90° ずらしてつなぐ。回している層が見えないフレーム（ぶれ・隠れた）が maxGapMs より長く続くか、層が変わったらつなぎ直す
export interface TurnTrack {
  slot: number;
  total: number; // 回し始めからの角度（ラジアン、軸の正の向きのまわり）
  last: number; // 最後に見えた θ
  lastT: number; // 最後に見えた時刻（ms）
}

export function unwrapTurn(prev: TurnTrack | null, turn: TurnShape | null, t = 0, maxGapMs = 80): TurnTrack | null {
  if (!turn) return prev && t - prev.lastT <= maxGapMs ? prev : null;
  if (!prev || prev.slot !== turn.slot || t - prev.lastT > maxGapMs) return { slot: turn.slot, total: turn.angle, last: turn.angle, lastT: t };
  let d = turn.angle - prev.last;
  while (d > Math.PI / 4) d -= Math.PI / 2;
  while (d < -Math.PI / 4) d += Math.PI / 2;
  return { slot: turn.slot, total: prev.total + d, last: turn.angle, lastT: t };
}

// 回している向き: 外から見て時計回りなら 1、反時計回りなら -1（total は軸の正の向きのまわり。上・右・正面の面は軸の正の側）
export const turnSense = (slot: number, total: number) => (total * (slot < 3 ? 1 : -1) < 0 ? 1 : -1);

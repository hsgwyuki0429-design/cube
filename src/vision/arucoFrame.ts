// ArUco ステッカー（各ステッカーに色付き ArUco マーカー。符号の種類は src/aruco/codes.ts）の認識。
// 色を読む代わりにマーカーの ID から色（センターの面）が確定するので、面の格子を探して色を読む代わりに
// マーカーから面を組み立て（src/aruco/cube.ts）、各セルの色を代表色の Lab にして返す。追跡・スキャン・精密解析は
// 普通のステッカーと同じ経路（FrameResult）で動く。
import { fillByColor, frameRefs, ringGeometry, skinFraction } from "../aruco/colorFill";
import { IdTracker } from "../aruco/idTrack";
import { type FacesResult, type VisibleFace, cellH, readConfidence, reconstructFaces, trustedColors, turnMarkers } from "../aruco/cube";
import { DEFAULT_GRID, colorFits, colorRefsOf, gridReadCell, gridReadFaces, stickerSide } from "../aruco/gridRead";
import { DEFAULT_TURN, type TurnResult, type TurnTrack, layerCells, projectedFace, recognizeTurn, unwrapTurn } from "../aruco/turn";
import type { TurnSnapshot } from "../track/types";
import type { Pose } from "./pose";
import { ArucoBench, DEFAULT_CONFIGS, type Marker, type Region, THOROUGH_PARAMS } from "../aruco/detect";
import { trackMarkers } from "../aruco/markerTrack";
import { type StickerScheme, decode, markerSize } from "../aruco/codes";
import { STANDARD_DESIGN, type StickerDesign, designOf } from "../aruco/design";
import { ARUCO_REFS } from "../aruco/palette";
import { type RereadMemory, rereadFaces } from "../aruco/reread";
import type { Lab } from "./color";
import { type Mat3, type Pt, applyH, cornerCenter, cornerPoints, invertH } from "./homography";
import type { DetectedFace, FrameResult } from "./pipeline";
import type { CV } from "./image";
import type { PixelSource } from "./image";

let bench: { cv: CV; scheme: StickerScheme; thorough: boolean; design: StickerDesign; b: ArucoBench } | null = null;
// 再認識（切り出したマス）用。二値化の窓を細かく試す
let rereader: { cv: CV; scheme: StickerScheme; design: StickerDesign; b: ArucoBench } | null = null;
// フレームの間で引き継ぐキューブの傾き（面が 1 つしか見えないときの向きの決定に使う）。記憶の入れ物ごと
const tilts = new WeakMap<object, { t: number; tilt: number[] | null }>();
// ID なし追跡（読めなくなったマスに直前のステッカーを引き継ぐ）。記憶の入れ物ごと
const trackers = new WeakMap<object, IdTracker>();
const TILT_MS = 1000;
// 回転途中の形状認識（記憶の入れ物ごと）: 直前の本体の姿勢と、回している層のつながり（回し始めからの角度）
const rereads = new WeakMap<object, RereadMemory>(); // 読み直しに失敗したマスの見た目（src/aruco/reread.ts）
const turnStates = new WeakMap<object, { pose: Pose | null; poseT: number; track: TurnTrack | null; snap: TurnSnapshot | null }>();
const POSE_MS = 500;
const TURN_GAP_MS = 80; // 回している層がこれより長く見えなければ、つながりを切る
// 直前のフレームのマーカーの範囲（切り出して検出するため。記憶の入れ物ごと）
const boxes = new WeakMap<object, Box>(); // small: 小さい方から 1 割のマーカーの辺
const REGION_MS = 200; // これより前のフレームの範囲は使わない
const REGION_MARGIN = 2.5; // 範囲を広げる量（マーカーの辺の倍数。キューブが少し動いても、回している層がはみ出しても入る）
// 範囲を広げる量の下限（画像の長辺に対する割合）。4 個の配置はマーカーが小さく、ライブ（1 秒 10〜20 枚）ではフレームの間に
// キューブがマーカーの辺の 2.5 倍より大きく動いて、全体でやり直すことが多かった
const REGION_MARGIN_MIN = 0.06;
const REGION_EDGE = 1; // 切り出しの縁からこれ（マーカーの辺の倍数）以内にマーカーがあれば、外にもあるかもしれないので全体でやり直す

// マーカーを検出する。region: 直前のフレームのマーカーの周りだけを切り出して検出する（ライブ・精密解析。画像全体の何割かで済む）。
// 切り出しの縁の近くにマーカーがある（キューブが大きく動いた）・何も見つからないときは全体でやり直す
// ライブ: マーカーがどれもこれより大きく（辺の画素。小さい方から 1 割のマーカー）映っていたら、切り出しを半分に縮めて検出する
// （縮めても 1 マスに 3 画素ほどある）。真ん中の大きさで決めると、斜めで小さく写る奥の上面のマーカーが縮めると読めず、B の手を
// 取りこぼした。
// 合成の 60 場面（4 個の配置）で、辺 30 画素以上なら縮めても色が正しく分かるマスは同じ（25 画素からだと 64.5 → 63.1%、
// いつも縮めると 34%）。精密解析では縮めない: 角の位置が粗くなり、手の時刻（回し始め・回し終わり）が 50〜350ms ずれた
// （OpenCV.js に角を元の画素で合わせ直す cornerSubPix がない）
const SHRINK_SIDE = 40;

// ライブ: 検出せずに前のフレームのマーカーを追う（src/aruco/markerTrack.ts）。最後に検出したときのマーカーの数の TRACK_KEEP 以上を
// 追えたら検出を省く（追うたびに少しずつ減っていくので、前のフレームではなく検出したときの数と比べる）。新しく見えたマーカー・
// 回し終えた層のマーカーを拾うため、TRACK_REDETECT_MS ごとには検出する
const tracks = new WeakMap<object, { t: number; detectT: number; detected: number; markers: Marker[]; shifts: Pt[] }>();
const TRACK_KEEP = 0.8;
const TRACK_REDETECT_MS = 250;
const TRACK_GAP_MS = 150;
// 格子で追う方式: 前のフレームから GRID_GAP_MS まで追う（マスごとに位置を合わせ、読めなければ検出に戻るので、間が開いても崩れない）。
// キューブ全体の検出は GRID_REDETECT_MS たって、かつ前の検出から GRID_REDETECT_FRAMES 枚以上のとき（新しく見えた面のため。処理の
// 遅い端末で 1 秒 3〜4 枚になると、ms だけで決めるとほぼ毎フレーム検出になり、さらに遅くなっていた）。切り出しは GRID_REGION_MS 前の
// 範囲まで使う（処理の遅い端末では、前のフレームが 200ms より前のことが多く、画像全体を検出してさらに遅くなっていた）
const GRID_GAP_MS = 1000;
const GRID_REDETECT_MS = 500;
const GRID_REDETECT_FRAMES = 3;
const GRID_REGION_MS = 1000;
const TRACK_MIN = 8;
const TRACK_MIN_FIT = 0.85; // 追ったマーカーの明暗が符号どおりの割合（検出と同じ: src/aruco/detect.ts の MIN_FIT）

type Box = { t: number; x0: number; y0: number; x1: number; y1: number; side: number; small: number };

// 直前のフレームのマーカーの範囲から、検出する切り出しと縮める倍率を決める（範囲が画像の 8 割を超えるなら全体）
function regionOf(prev: Box, img: { width: number; height: number }, shrinkSide: number): DetectHint | null {
  const m = Math.max(REGION_MARGIN * prev.side, REGION_MARGIN_MIN * Math.max(img.width, img.height));
  const x0 = Math.max(0, Math.floor(prev.x0 - m));
  const y0 = Math.max(0, Math.floor(prev.y0 - m));
  const x1 = Math.min(img.width, Math.ceil(prev.x1 + m));
  const y1 = Math.min(img.height, Math.ceil(prev.y1 + m));
  if ((x1 - x0) * (y1 - y0) >= img.width * img.height * 0.8) return null;
  return { region: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, shrink: prev.small >= shrinkSide ? 2 : 1, edge: REGION_EDGE * prev.side };
}

// 検出の手がかり: 切り出し・縮める倍率・縁の近さ（これより縁に近いマーカーがあれば全体でやり直す）
export interface DetectHint {
  region: Region;
  shrink: 1 | 2;
  edge: number;
}

// 手がかりの切り出しで検出し、縁の近くにマーカーがある（キューブが大きく動いた）・何も見つからないときは全体でやり直す。
// フレームの間で引き継ぐものを使わないので、別の Worker でも動く（精密解析の並列化: src/vision/detectPool.ts）
export function detectWithHint(b: ArucoBench, img: PixelSource, hint: DetectHint | null): Marker[] {
  if (hint) {
    const { region: r, shrink, edge: e } = hint;
    const found = b.detect(img, r, shrink)[0].markers;
    const x1 = r.x + r.w;
    const y1 = r.y + r.h;
    const nearEdge = found.some((mk) =>
      [0, 2, 4, 6].some((i) => (mk.corners[i] - r.x < e && r.x > 0) || (x1 - mk.corners[i] < e && x1 < img.width) || (mk.corners[i + 1] - r.y < e && r.y > 0) || (y1 - mk.corners[i + 1] < e && y1 < img.height)),
    );
    if (found.length && !nearEdge) return found;
  }
  return b.detect(img)[0].markers;
}

// 次のフレームの切り出しのために、マーカーの範囲を覚える
function rememberBox(memory: object, t: number, markers: Marker[]): void {
  if (markers.length < 4) {
    boxes.delete(memory);
    return;
  }
  const xs = markers.flatMap((mk) => [mk.corners[0], mk.corners[2], mk.corners[4], mk.corners[6]]);
  const ys = markers.flatMap((mk) => [mk.corners[1], mk.corners[3], mk.corners[5], mk.corners[7]]);
  const sides = markers.map((mk) => mk.side).sort((p, q) => p - q);
  boxes.set(memory, { t, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), side: sides[Math.floor(sides.length / 2)], small: sides[Math.floor(sides.length * 0.1)] });
}

// 精密解析を並列にするとき: 次に検出するフレームの手がかり（最後に処理し終えたフレームのマーカーの範囲から）。
// 処理し終えたフレームは数枚遅れるので、少し古い範囲まで使う（キューブが大きく動いていれば、縁の近くに見つかって全体でやり直す）
const PARALLEL_REGION_MS = 400;
export function detectHint(memory: object, img: { width: number; height: number }, t: number): DetectHint | null {
  const prev = boxes.get(memory);
  return prev && t - prev.t < PARALLEL_REGION_MS && t > prev.t ? regionOf(prev, img, Infinity) : null;
}

// 検出器（精密解析の設定）。別の Worker で検出だけするとき
export function detectorFor(cv: CV, scheme: StickerScheme, thorough: boolean, designKey: string): ArucoBench {
  const design = designOf(designKey);
  if (!bench || bench.cv !== cv || bench.scheme !== scheme || bench.thorough !== thorough || bench.design !== design) {
    bench?.b.delete();
    const config = thorough ? { ...DEFAULT_CONFIGS[1], params: THOROUGH_PARAMS } : DEFAULT_CONFIGS[1]; // max(RGB)
    bench = { cv, scheme, thorough, design, b: new ArucoBench(cv, [config], scheme, design) };
  }
  return bench.b;
}

function detectMarkers(b: ArucoBench, img: PixelSource, t: number, memory: object, region: boolean, shrinkSide = Infinity, track = false): Marker[] {
  const prev = region ? boxes.get(memory) : undefined;
  let markers: Marker[] | null = null;
  const tr = track ? tracks.get(memory) : undefined;
  let tracked = false;
  let shifts: Pt[] = [];
  if (tr && t > tr.t && t - tr.t < TRACK_GAP_MS && t - tr.detectT < TRACK_REDETECT_MS && tr.markers.length >= TRACK_MIN) {
    const got = trackMarkers(img, tr.markers, (id) => b.bitsOf(id), b.cellCount, (_, k) => tr.shifts[k] ?? [0, 0]);
    if (got.length >= tr.detected * TRACK_KEEP) {
      const ms = got.map((g) => b.describeMarker(img, g.id, g.corners));
      const keep = ms.map((m) => m.fit >= TRACK_MIN_FIT);
      markers = ms.filter((_, k) => keep[k]);
      shifts = got.filter((_, k) => keep[k]).map((g) => g.shift);
      tracked = markers.length >= tr.detected * TRACK_KEEP;
      if (!tracked) markers = null;
    }
  }
  if (!markers) {
    const hint = prev && t - prev.t < REGION_MS && t > prev.t ? regionOf(prev, img, shrinkSide) : null;
    markers = detectWithHint(b, img, hint);
  }
  if (track) tracks.set(memory, { t, detectT: tracked ? tr!.detectT : t, detected: tracked ? tr!.detected : markers.length, markers, shifts: tracked ? shifts : [] });
  if (region) rememberBox(memory, t, markers);
  return markers;
}

// ライブの認識の前段（マーカーを集める）。2 つの方式:
//   追う（arucoTrack）: 前のフレームのマーカーを 1 つずつ少しずらして探す（src/aruco/markerTrack.ts）。追えたのが検出したときの
//     TRACK_KEEP 未満なら検出する。速く回すと回している層のマーカーが毎回外れ、ほぼ毎フレーム検出になっていた
//   格子で追う（arucoGrid）: 最近見えていた面の格子の各マスで位置を少し合わせ、そのままマーカーのマスの明暗を読んで ID を決める
//     （src/aruco/gridRead.ts）。マーカーではなく「マス」を追うので、回し終わった層の新しいステッカーも検出せずに読める。
//     回している途中の層・指で隠れたマスは読めないまま。回している途中に外れた面（U を回している間の上の面）も、最後に見えた格子で
//     読み続けるので、回し終われば検出せずに戻る。面が MISSING_MS より長く戻らなければ、その面のあった範囲だけを検出する。
//     正面が組み立てられない（キューブが大きく動いた・持ち替え）か、GRID_REDETECT_MS たったら、キューブ全体の範囲を検出する
const FACE_MEMORY_MS = 800; // これより前に見えていた面は、なくなっていても探さない
const MISSING_MS = 250; // 面がこれより長く戻らなければ、その面のあった範囲を検出する（回している間は待つ）
const CLIMB = { ...DEFAULT_GRID, climb: true };
interface KnownFace {
  t: number; // 最後に見えた時刻
  face: VisibleFace;
  side: number; // ステッカーの辺（面の座標）
  box: Region;
  spot: FaceSpot;
  tried: number; // 範囲を検出した時刻
}
interface LiveState {
  t: number;
  detectT: number;
  detected: number; // 最後にキューブ全体を検出したときのマーカーの数
  markers: Marker[];
  shifts: Pt[]; // マーカーごとの前のフレームからの動き（追う方式の次のフレームの予測）
  known: Map<number, KnownFace>; // 格子で追う方式: 面（カメラフレームの面）ごとの最後に見えた格子
  since: number; // キューブ全体を検出してから処理したフレームの数
  offsets: Map<number, Pt>; // 格子で追う方式: マス（slot * 9 + cell）ごとの、面の格子から合わせた位置のずれ
}
const lives = new WeakMap<object, LiveState>();

function faceBox(f: { outline: Pt[] }, img: { width: number; height: number }, pad: number): Region {
  const xs = f.outline.map((p) => p[0]);
  const ys = f.outline.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
  const x1 = Math.min(img.width, Math.ceil(Math.max(...xs) + pad));
  const y1 = Math.min(img.height, Math.ceil(Math.max(...ys) + pad));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

// 面の画像の上の位置: 真ん中のマスの中心と、大きさ（外枠の面積の平方根）
interface FaceSpot {
  c: Pt;
  size: number;
}
function spotOf(f: { H: Mat3; outline: Pt[] }): FaceSpot {
  const o = f.outline;
  let area = 0;
  for (let i = 0; i < o.length; i++) {
    const a = o[i];
    const b = o[(i + 1) % o.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return { c: applyH(f.H, 1.5, 1.5), size: Math.sqrt(Math.abs(area) / 2) };
}
// 同じ面か: 真ん中の距離が大きさの SAME_FACE 倍より近い（隣の面の真ん中は大きさの 0.7〜1 倍ほど離れている。外接する矩形の重なりで
// 決めていた間は、近くから見た正面と上の面の矩形が大きく重なって同じ面とみなし、正面を読まずに飛ばしていた）
const SAME_FACE = 0.4;
const sameFace = (a: FaceSpot, b: FaceSpot) => Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1]) < SAME_FACE * Math.min(a.size, b.size);

// 面の割り当ての入れ替わり: 前のフレームでスロット p だった面（画像の上で重なる）がいまは別のスロット s になっていて、p はいま空き、
// 前に s だった面がいまは見えていない。斜めから見ているとき（正面と右がどちらもカメラの軸から 45° ほど）に正面を回すと、正面が読めない間、
// 右の面が向きの上では正面に近いので正面と割り当てられ、右の面のステッカーを正面として観測していた（追跡は持ち替えか余計な手で
// 辻褄を合わせ、精密解析では最後の F2 を見落としてタイムが 276ms 短かった）。キューブを持ち替えたときは、前に s だった面も
// 隣の面として見えたまま動くので入れ替わりとはみなさない
const slotMemory = new WeakMap<object, { t: number; faces: { slot: number; spot: FaceSpot }[] }>();
const SLOT_JUMP_MS = 300; // これより前のフレームとは比べない（回し終わって面が戻ってくるまで）
function slotJump(memory: object, faces: VisibleFace[], t: number): boolean {
  const prev = slotMemory.get(memory);
  if (!prev || t <= prev.t || t - prev.t > SLOT_JUMP_MS) return false;
  const now = faces.filter((f) => !f.partial).map((f) => ({ slot: f.slot, spot: spotOf(f) }));
  return now.some((f) => {
    const was = prev.faces.find((p) => p.slot !== f.slot && sameFace(p.spot, f.spot));
    if (!was || now.some((g) => g.slot === was.slot)) return false;
    const occupant = prev.faces.find((p) => p.slot === f.slot);
    return !!occupant && !now.some((g) => g !== f && sameFace(g.spot, occupant.spot));
  });
}

// マーカーを足す（同じ ID で中心が近いものは後から足した方に置き換える）
function mergeMarkers(base: Marker[], add: Marker[]): void {
  for (const m of add) {
    const c = cornerCenter(m.corners);
    let k = -1;
    for (let i = 0; i < base.length && k < 0; i++) {
      if (base[i].id !== m.id) continue;
      const d = cornerCenter(base[i].corners);
      if (Math.hypot(d[0] - c[0], d[1] - c[1]) < m.side * 0.5) k = i;
    }
    if (k >= 0) base[k] = m;
    else base.push(m);
  }
}

// 前のフレームまでの状態に、このフレームの面を覚える。tried: 範囲を検出した面
function rememberLive(memory: object, st: LiveState | undefined, img: PixelSource, t: number, design: StickerDesign, markers: Marker[], shifts: Pt[], faces: FacesResult, detectT: number, detected: number, offsets: Map<number, Pt>, tried?: Set<number>): void {
  const known = new Map<number, KnownFace>();
  const now: KnownFace[] = [];
  for (const f of faces.faces) {
    if (f.partial) continue;
    const side = stickerSide(f, markers, design);
    if (side) now.push({ t, face: f, side, box: faceBox(f, img, 0), spot: spotOf(f), tried: -Infinity });
  }
  // 前に見えていた面: いま見えている面と重なるもの（同じ面が別のスロットになった: 斜めから見て正面と右が入れ替わった）は捨てる
  for (const [slot, k] of st?.known ?? []) if (t - k.t <= FACE_MEMORY_MS && !now.some((n) => sameFace(n.spot, k.spot))) known.set(slot, tried?.has(slot) ? { ...k, tried: t } : k);
  for (const k of now) known.set(k.face.slot, k);
  lives.set(memory, { t, detectT, detected, markers, shifts, known, offsets, since: detectT === t ? 0 : (st?.since ?? 0) + 1 });
  rememberBox(memory, t, markers);
}

// 最近見えていた面の格子で、各マスを読む（新しい方から。前に読んだ面と重なる面は読まない）
function readKnown(st: LiveState, img: PixelSource, scheme: StickerScheme, design: StickerDesign): { markers: Marker[]; offsets: Map<number, Pt> } {
  const markers: Marker[] = [];
  const offsets = new Map<number, Pt>();
  const used: FaceSpot[] = [];
  // 色の仲間は前のフレームのマーカーから（このフレームはこれから読む）
  const refs = colorRefsOf(st.markers, scheme);
  for (const [slot, k] of [...st.known].sort((a, b) => b[1].t - a[1].t)) {
    if (used.some((u) => sameFace(u, k.spot))) continue;
    used.push(k.spot);
    for (let cell = 0; cell < 9; cell++) {
      const key = slot * 9 + cell;
      const g = gridReadCell(img, cellH(k.face, cell), cell, scheme, design, k.side, CLIMB, st.offsets.get(key) ?? [0, 0], [1]);
      if (!g || !colorFits(refs, g.face, g.markers[0].rgb)) continue;
      mergeMarkers(markers, g.markers);
      offsets.set(key, g.offset);
    }
  }
  return { markers, offsets };
}

// 面の割り当てが前と変わった（正面を回していて正面が読めず、上の面が正面になった）か
function relabeled(st: LiveState, fs: FacesResult): boolean {
  return fs.faces.some((f) => {
    const spot = spotOf(f);
    return [...st.known].some(([slot, k]) => slot !== f.slot && sameFace(spot, k.spot) && !fs.faces.some((g) => g !== f && g.slot === slot));
  });
}

function liveMarkers(
  b: ArucoBench,
  img: PixelSource,
  t: number,
  memory: object,
  shrinkSide: number,
  grid: boolean,
  build: (ms: Marker[]) => FacesResult,
  scheme: StickerScheme,
  design: StickerDesign,
): { markers: Marker[]; faces: FacesResult } {
  const st = lives.get(memory);
  const remember = (markers: Marker[], shifts: Pt[], faces: FacesResult, detectT: number, detected: number, offsets: Map<number, Pt>, tried?: Set<number>) =>
    rememberLive(memory, st, img, t, design, markers, shifts, faces, detectT, detected, offsets, tried);
  const canTrack = !!st && t > st.t && (grid ? t - st.t < GRID_GAP_MS && (t - st.detectT < GRID_REDETECT_MS || st.since < GRID_REDETECT_FRAMES) : t - st.t < TRACK_GAP_MS && t - st.detectT < TRACK_REDETECT_MS);
  if (canTrack && !grid && st.markers.length >= TRACK_MIN) {
    const got = trackMarkers(img, st.markers, (id) => b.bitsOf(id), b.cellCount, (_, k) => st.shifts[k] ?? [0, 0]);
    const markers: Marker[] = [];
    const shifts: Pt[] = [];
    for (const g of got) {
      const m = b.describeMarker(img, g.id, g.corners);
      if (m.fit < TRACK_MIN_FIT) continue;
      markers.push(m);
      shifts.push(g.shift);
    }
    if (markers.length >= st.detected * TRACK_KEEP) {
      const faces = build(markers);
      remember(markers, shifts, faces, st.detectT, st.detected, new Map());
      liveStats.tracked++;
      return { markers, faces };
    }
  }
  if (canTrack && grid && st.known.size) {
    const { markers, offsets } = readKnown(st, img, scheme, design);
    if (markers.length >= TRACK_MIN) {
      let faces = build(markers);
      // 戻らない面: その面のあった範囲だけ検出する。面の割り当てが変わった（正面が読めず、残りの面が正面とみなされた）ときはすぐ、
      // ほかは MISSING_MS より長く戻らなければ（同じ面は MISSING_MS ごとに 1 回まで）。正面がないだけ（回している・指で隠れた）なら
      // 待つ: 回し終われば最後の格子で読めて戻る（すぐ検出していた間は、速く回すと 4 フレームに 1 回はこの検出になり重かった）
      const urgent = relabeled(st, faces);
      const lost = [...st.known].filter(([slot, k]) => (urgent ? t - k.tried > 0 : t - k.t > MISSING_MS && t - k.tried > MISSING_MS) && !faces.faces.some((f) => f.slot === slot && !f.partial));
      if (lost.length) {
        // 外れた面の範囲をまとめて 1 回だけ検出する（面ごとに検出すると、重なった範囲を何度も二値化していた）
        const pad = Math.max(...markers.map((m) => m.side)) * 1.5;
        const x0 = Math.max(0, Math.floor(Math.min(...lost.map(([, k]) => k.box.x)) - pad));
        const y0 = Math.max(0, Math.floor(Math.min(...lost.map(([, k]) => k.box.y)) - pad));
        const x1 = Math.min(img.width, Math.ceil(Math.max(...lost.map(([, k]) => k.box.x + k.box.w)) + pad));
        const y1 = Math.min(img.height, Math.ceil(Math.max(...lost.map(([, k]) => k.box.y + k.box.h)) + pad));
        const r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        const small = boxes.get(memory)?.small ?? 0;
        if (r.w >= 16 && r.h >= 16) mergeMarkers(markers, b.detect(img, r, small >= shrinkSide && r.w >= 64 && r.h >= 64 ? 2 : 1)[0].markers);
        faces = build(markers);
        const again = faces.faces.filter((f) => lost.some(([slot]) => slot === f.slot));
        if (again.length) markers.push(...gridReadFaces(img, again, markers, scheme, design));
        liveStats.partial++;
        liveStats.last = `partial:${lost.map(([slot, k]) => `${slot}@${Math.round(t - k.t)}${urgent ? "!" : ""}`).join(",")}`;
      }
      // 正面があるか、正面がないのが MISSING_MS までなら、このフレームはこれで済ませる（正面のないフレームは観測にしない: processAruco）
      const front = faces.faces.some((f) => f.slot === 2 && !f.partial) || (!!st.known.get(2) && t - st.known.get(2)!.t <= MISSING_MS && faces.faces.length > 0);
      if (front && !relabeled(st, faces)) {
        if (!lost.length) {
          liveStats.gridded++;
          liveStats.last = "grid";
        }
        remember(markers, [], faces, st.detectT, st.detected, offsets, new Set(lost.map(([slot]) => slot)));
        return { markers, faces };
      }
    }
  }
  const prev = boxes.get(memory);
  const hint = prev && t - prev.t < (grid ? GRID_REGION_MS : REGION_MS) && t > prev.t ? regionOf(prev, img, shrinkSide) : null;
  const markers = detectWithHint(b, img, hint);
  const faces = build(markers);
  if (grid && faces.faces.length) markers.push(...gridReadFaces(img, faces.faces, markers, scheme, design));
  remember(markers, markers.map((): Pt => [0, 0]), faces, t, markers.length, new Map());
  liveStats.detected++;
  liveStats.last = hint ? "detect" : "detect-full";
  return { markers, faces };
}

// 調査用: ライブのフレームのうち、追えた・格子で読んで済んだ・検出したフレームの数
export const liveStats = { tracked: 0, gridded: 0, partial: 0, detected: 0, last: "" };

// thorough: 精密解析（時間をかけてよい）。二値化の窓を細かく試す（THOROUGH_PARAMS）
// opts.reread: 読めなかったマスを読み直す数（省略時はライブ 0・精密解析は全部）、opts.focus: 先に読み直すマス（slot * 9 + cell）、
// opts.colorFill: それでも読めなかったマスを色で補う（既定 true。src/aruco/colorFill.ts）、
// opts.idTrack: ID が読めなかったマスに直前のフレームのステッカーを引き継ぐ（既定 true。src/aruco/idTrack.ts）、
// opts.region: 直前のフレームのマーカーの周りだけで検出する（本体のライブと精密解析。既定 false）、
// opts.design: ステッカーの中のマーカーの配置（src/aruco/design.ts の key。既定は今の配置 standard）、
// opts.turn: 回転途中の形状認識で、回している層と回し始めからの角度を出す（既定 true。src/aruco/turn.ts）
export function processAruco(
  cv: CV,
  img: PixelSource,
  t: number,
  memory: object,
  scheme: StickerScheme = "aruco54",
  thorough = false,
  opts: { reread?: number; focus?: number[]; colorFill?: boolean; idTrack?: boolean; region?: boolean; design?: string; turn?: boolean; shrink?: boolean; track?: boolean; grid?: boolean; fineWindows?: boolean } = {},
  detected?: Marker[], // 別の Worker で検出したマーカー（精密解析の並列化。detectWithHint）
): FrameResult {
  const design = designOf(opts.design ?? STANDARD_DESIGN.key);
  const b = detectorFor(cv, scheme, opts.fineWindows ?? thorough, design.key);
  let markers: Marker[];
  const prev = tilts.get(memory);
  const build = (ms: Marker[]) => reconstructFaces(ms, img, prev && t - prev.t < TILT_MS ? prev.tilt : null, scheme, undefined, true, design);
  let r: FacesResult;
  let liveGrid = false;
  const liveBefore = lives.get(memory);
  if (detected) {
    markers = detected;
    if (opts.region) rememberBox(memory, t, markers);
    r = build(markers);
  } else if (opts.track && !thorough && opts.region) {
    const lv = liveMarkers(b, img, t, memory, opts.shrink === false ? Infinity : SHRINK_SIDE, !!opts.grid, build, scheme, design);
    markers = lv.markers;
    r = lv.faces;
    liveGrid = !!opts.grid;
  } else {
    markers = detectMarkers(b, img, t, memory, !!opts.region, opts.shrink === false || thorough ? Infinity : SHRINK_SIDE, !!opts.track && !thorough);
    r = build(markers);
  }
  // 面の割り当てが、消えた面の代わりに入れ替わった（下の slotJump）フレームは使わない。ライブの格子で追う状態も前のフレームのままにする
  if (r.faces.length && slotJump(memory, r.faces, t)) {
    r = { faces: [], tilt: r.tilt };
    if (liveBefore) lives.set(memory, liveBefore);
    else lives.delete(memory);
  } else if (r.faces.length) slotMemory.set(memory, { t, faces: r.faces.filter((f) => !f.partial).map((f) => ({ slot: f.slot, spot: spotOf(f) })) });
  if (r.faces.length) tilts.set(memory, { t, tilt: r.tilt });
  // 回転途中の形: 回している層が見えたら、その層が通る面の外側の 1 列を層の格子で置き、面から外れた層のマーカーもその列に入れる
  const tr = opts.turn === false || !r.faces.length ? null : recognizeTurnFor(markers, r.faces, img, t, memory, design);
  if (tr?.turn && tr.pose) applyTurnLayers(r.faces, tr, img, markers, scheme);
  // ライブは読み直さない: 1 フレームの 3 割（合成の 30fps で 64 → 38ms）を使うのに、手順の正確さは変わらず（読めなかったマスは
  // 色で補う・ID なし追跡・次のフレームで埋まる）、処理が追いつかない端末ではその分フレームを捨てて見落とした
  const budget = opts.reread ?? (thorough ? 27 : 0);
  if (budget > 0 && r.faces.length) {
    if (!rereader || rereader.cv !== cv || rereader.scheme !== scheme || rereader.design !== design) {
      rereader?.b.delete();
      rereader = { cv, scheme, design, b: new ArucoBench(cv, [{ ...DEFAULT_CONFIGS[1], params: THOROUGH_PARAMS }], scheme, design) };
    }
    let rm = rereads.get(memory);
    if (!rm) rereads.set(memory, (rm = new Map()));
    rereadFaces(rereader.b, img, r.faces, scheme, budget, new Set(opts.focus ?? []), rm);
  }
  // 格子で読む（ライブは liveMarkers の中で読んでいる）: 読めなかったマスを、面の格子（回している途中の層は層の格子）で読む
  if (opts.grid && !liveGrid && r.faces.length) markers = [...markers, ...gridReadFaces(img, r.faces, markers, scheme, design)];
  // 色による補完: 読めたマーカー（ID から色が分かる）の写った色を、そのフレームの色の基準にする
  if (opts.colorFill !== false && r.faces.length) fillByColor(img, r.faces, frameRefs(trustedColors(markers, scheme)), ringGeometry(design, markerSize(scheme)));
  // ID なし追跡: 色で補ったマス（色が合えば）と読めなかったマスに、直前のフレームの同じマスのステッカーを引き継ぐ
  if (opts.idTrack !== false) {
    let tracker = trackers.get(memory);
    if (!tracker) trackers.set(memory, (tracker = new IdTracker()));
    const bySlot = new Map(r.faces.map((f) => [f.slot, f]));
    tracker.update(t, r.faces, null, (slot, cell) => skinFraction(img, cellH(bySlot.get(slot)!, cell), cell) > 0.15);
  }
  const turn = tr ? turnSnapshot(tr, t, memory) : undefined;
  const shifts = scheme === "unique54" ? r.faces.map((f) => cellShifts(f, markers, design)) : null;
  const quads: Pt[][] = markers.map((m) => cornerPoints(m.corners));
  const faces: DetectedFace[] = r.faces.map((f, fi) => {
    const known = f.colors.map((c) => c >= 0);
    return {
      slot: f.slot,
      rot: 0,
      H: f.H,
      found: known.filter(Boolean).length,
      labs: f.colors.map((c) => (c >= 0 ? ([...ARUCO_REFS[c]] as Lab) : ([0, 0, 0] as Lab))),
      // 回している途中の層のマスは「動いている」（手の時刻の判定: src/track/timing.ts は、層の側面のマスが止まっているときと
      // 変わったフレームを回し始めとする。層の格子で追うと回す前と同じステッカーが読めるので、変わっていないように見えてしまう）
      spread: Array.from({ length: 9 }, (_, cell) => (f.layer?.cells.includes(cell) ? MOVING_SPREAD : 0)),
      valid: known,
      // 読みの確からしさ（マーカーの fit。読み直したマスは少し弱い: src/aruco/reread.ts）
      weight: f.conf,
      // 指で隠れている: マーカーが読めず、マスに肌らしい色が多い（手の時刻の判定に使わない。指が横切ってマーカーが読めなくなったのを
      // 層の動き出しと取り違えないように）。マーカーが読めたマスは隠れていない
      masked: Array.from({ length: 9 }, (_, cell) => (shifts ? !shifts[fi][cell] && skinFraction(img, cellH(f, cell), cell) > FINGER_SKIN : false)),
      // 1 列・1 枚の面: 色は使うが、外枠は推定なので 3D の傾き（estimatePose）には使わない
      held: !!f.partial,
      ...(f.ids.some((id) => id >= 0) ? { ids: f.ids } : {}),
      ...(f.layer ? { layer: f.layer } : {}),
      ...(shifts ? { shift: shifts[fi] } : {}),
      ...(f.marker ? { marker: f.marker } : {}),
    };
  });
  // 普通のステッカーと同じく正面（スロット 2）を先頭に。面があれば必ず正面がある（reconstructFaces の frontAlways）
  const front = faces.find((f) => f.slot === 2);
  if (!front) return { faces: [], quads, turn };
  return { faces: [front, ...faces.filter((f) => f !== front)], quads, turn };
}

// マスごとの、読んだマーカーの本体の格子（f.H）からのずれ（面の座標 = マスの間隔 1。読めなければ null）。層が回り始めると、
// 層の側面のマスのマーカーは数度でも格子から動く。マーカーから組み立てた面の色は代表色なので、色の読みでは ID が読めている間は
// 変わらず、手の時刻（src/track/timing.ts）の回し始めが回し終わり近くまで遅れていた。マーカーごとにステッカーの中の決まった位置
// （design.at）からのずれにするので、指で一部のマーカーが隠れても値は変わらない
function cellShifts(f: VisibleFace, markers: Marker[], design: StickerDesign): (Pt | null)[] {
  const out: (Pt | null)[] = new Array(9).fill(null);
  const cellOf = new Map<number, number>();
  f.ids.forEach((id, cell) => id >= 0 && cellOf.set(id, cell));
  if (!cellOf.size || !f.marker) return out;
  const inv = invertH(f.H);
  const sticker = f.marker / VIRTUAL_SIDE;
  const sum = Array.from({ length: 9 }, () => [0, 0, 0]);
  for (const m of markers) {
    const cell = cellOf.get(m.id);
    if (cell === undefined) continue;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < 4; i++) {
      cx += m.corners[i * 2] / 4;
      cy += m.corners[i * 2 + 1] / 4;
    }
    const [u, v] = applyH(inv, cx, cy);
    const lx = u - ((cell % 3) + 0.5);
    const ly = v - (Math.floor(cell / 3) + 0.5);
    let best: Pt | null = null;
    for (const [ax, ay] of design.at) {
      const d: Pt = [lx - (ax - 0.5) * sticker, ly - (ay - 0.5) * sticker];
      if (!best || Math.hypot(...d) < Math.hypot(...best)) best = d;
    }
    if (!best || Math.hypot(...best) > 0.45) continue;
    sum[cell][0] += best[0];
    sum[cell][1] += best[1];
    sum[cell][2]++;
  }
  for (let c = 0; c < 9; c++) if (sum[c][2]) out[c] = [sum[c][0] / sum[c][2], sum[c][1] / sum[c][2]];
  return out;
}
const FINGER_SKIN = 0.15; // 肌らしい色の点の割合がこれを超えたら指で隠れている（ID なし追跡と同じ）
const VIRTUAL_SIDE = 0.84; // マーカーの辺 / ステッカーの辺（今の配置。4 個の配置の仮想のマーカーも同じ: src/aruco/cube.ts の virtualMarkers）

// 回転途中の形状認識: 回している層と角度を求める（本体の姿勢は前のフレームのものも候補に入れる）
function recognizeTurnFor(markers: Marker[], faces: VisibleFace[], img: PixelSource, t: number, memory: object, design: StickerDesign): TurnResult {
  const st = turnStates.get(memory) ?? { pose: null, poseT: -Infinity, track: null, snap: null };
  turnStates.set(memory, st);
  const tr = recognizeTurn(turnMarkers(markers, design), faces, img, st.pose && t - st.poseT < POSE_MS && t > st.poseT ? st.pose : null, { ...DEFAULT_TURN, design });
  if (tr.pose) {
    st.pose = tr.pose;
    st.poseT = t;
  }
  return tr;
}

// 層を回している途中のフレームで、層が通る面（4 面のうち見えているもの）の外側の 1 列を、本体の格子とは別の格子（層の格子）にする。
// 層の格子 = 観測した本体の格子に、姿勢から射影した「回した面の平面」と「回していない面の平面」の関係を掛けたもの（姿勢の誤差は
// 両方に同じように入るので打ち消し合う）。面の組み立てで同じ列が層として分けてあればそれを使う。
// 層のマーカーは本体の格子に合わないので面から外れていることがある: 形状認識で層のマスに置いたマーカーを、読めていないマスに入れる。
// 隠れたマスも、その列にあれば層の格子で置く（ほかに決め手がなければ、同じ列のマスと一緒に動いたと考える）
const LAYER_CONF = 0.7;
const MOVING_SPREAD = 100; // 回している途中の層のマスのばらつき（DetectedFace.spread） // 形状認識で層に置いたマーカーの読みの確からしさ
function applyTurnLayers(faces: VisibleFace[], tr: TurnResult, size: { width: number; height: number }, markers: Marker[], scheme: StickerScheme): void {
  const turn = tr.turn!;
  const pose = tr.pose!;
  for (const f of faces) {
    if (f.partial) continue;
    const cells = layerCells(f.slot, turn);
    if (cells.length !== 3) continue;
    if (f.layer && f.layer.cells.join() === cells.join()) continue;
    const Mb = projectedFace(pose, size, f.slot);
    const Ml = projectedFace(pose, size, f.slot, turn);
    if (!Mb || !Ml) continue;
    const H = mulH(Ml, mulH(invertH(Mb), f.H));
    const rows = cells.map((k) => Math.floor(k / 3));
    const cols = cells.map((k) => k % 3);
    f.layer = { cells, H, rect: [Math.min(...cols), Math.min(...rows), Math.max(...cols) + 1, Math.max(...rows) + 1] };
  }
  const fitOf = new Map(markers.map((m) => [m.id, m.fit]));
  for (const p of tr.placed) {
    if (!p.layer) continue;
    const f = faces.find((x) => x.slot === Math.floor(p.sticker / 9));
    const cell = p.sticker % 9;
    if (!f?.layer?.cells.includes(cell) || f.colors[cell] >= 0) continue;
    const dec = decode(scheme, p.id);
    if (!dec) continue;
    f.colors[cell] = dec.face;
    f.ids[cell] = dec.sticker;
    f.conf[cell] = Math.min(LAYER_CONF, readConfidence(fitOf.get(p.id) ?? 0));
  }
}

const mulH = (a: Mat3, b: Mat3): Mat3 => {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out.push(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]);
  return out;
};

// 回している層と角度を前のフレームとつなぐ（同じ層が回り続けていれば、回し始めからの角度を足していく）。
// 回している層が見えたフレームだけ、そのつながりを返す
function turnSnapshot(tr: TurnResult, t: number, memory: object): TurnSnapshot | undefined {
  const st = turnStates.get(memory)!;
  const prev = st.track;
  st.track = unwrapTurn(st.track, tr.turn, t, TURN_GAP_MS);
  if (!tr.turn || !st.track) return undefined;
  // unwrapTurn と同じ条件で、新しいつながりか
  const cont = !!prev && !!st.snap && prev.slot === tr.turn.slot && t - prev.lastT <= TURN_GAP_MS;
  st.snap = cont
    ? { ...st.snap!, total: st.track.total, frames: st.snap!.frames + 1, maxStep: Math.max(st.snap!.maxStep, Math.abs(st.track.total - prev!.total)) }
    : { slot: st.track.slot, start: t, first: tr.turn.angle, total: st.track.total, frames: 1, maxStep: 0 };
  return st.snap;
}

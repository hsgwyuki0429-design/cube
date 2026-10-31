// ArUco ステッカー（各ステッカーに色付き ArUco マーカー。符号の種類は src/aruco/codes.ts）の認識。
// 色を読む代わりにマーカーの ID から色（センターの面）が確定するので、面の格子を探して色を読む代わりに
// マーカーから面を組み立て（src/aruco/cube.ts）、各セルの色を代表色の Lab にして返す。追跡・スキャン・精密解析は
// 普通のステッカーと同じ経路（FrameResult）で動く。
import { fillByColor, frameRefs, ringGeometry, skinFraction } from "../aruco/colorFill";
import { IdTracker } from "../aruco/idTrack";
import { type VisibleFace, cellH, readConfidence, reconstructFaces, trustedColors, turnMarkers } from "../aruco/cube";
import { DEFAULT_TURN, type TurnResult, type TurnTrack, layerCells, projectedFace, recognizeTurn, unwrapTurn } from "../aruco/turn";
import type { TurnSnapshot } from "../track/types";
import type { Pose } from "./pose";
import { ArucoBench, DEFAULT_CONFIGS, type Marker, THOROUGH_PARAMS } from "../aruco/detect";
import { type StickerScheme, decode, markerSize } from "../aruco/codes";
import { STANDARD_DESIGN, type StickerDesign, designOf } from "../aruco/design";
import { ARUCO_REFS } from "../aruco/palette";
import { type RereadMemory, rereadFaces } from "../aruco/reread";
import type { Lab } from "./color";
import { type Mat3, type Pt, invertH } from "./homography";
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
const boxes = new WeakMap<object, { t: number; x0: number; y0: number; x1: number; y1: number; side: number; small: number }>(); // small: 小さい方から 1 割のマーカーの辺
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

function detectMarkers(b: ArucoBench, img: PixelSource, t: number, memory: object, region: boolean, shrinkSide = Infinity): Marker[] {
  const prev = region ? boxes.get(memory) : undefined;
  let markers: Marker[] | null = null;
  if (prev && t - prev.t < REGION_MS && t > prev.t) {
    const m = Math.max(REGION_MARGIN * prev.side, REGION_MARGIN_MIN * Math.max(img.width, img.height));
    const x0 = Math.max(0, Math.floor(prev.x0 - m));
    const y0 = Math.max(0, Math.floor(prev.y0 - m));
    const x1 = Math.min(img.width, Math.ceil(prev.x1 + m));
    const y1 = Math.min(img.height, Math.ceil(prev.y1 + m));
    if ((x1 - x0) * (y1 - y0) < img.width * img.height * 0.8) {
      const found = b.detect(img, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, prev.small >= shrinkSide ? 2 : 1)[0].markers;
      const e = REGION_EDGE * prev.side;
      const nearEdge = found.some((mk) =>
        [0, 2, 4, 6].some((i) => (mk.corners[i] - x0 < e && x0 > 0) || (x1 - mk.corners[i] < e && x1 < img.width) || (mk.corners[i + 1] - y0 < e && y0 > 0) || (y1 - mk.corners[i + 1] < e && y1 < img.height)),
      );
      if (found.length && !nearEdge) markers = found;
    }
  }
  markers ??= b.detect(img)[0].markers;
  if (region) {
    if (markers.length >= 4) {
      const xs = markers.flatMap((mk) => [mk.corners[0], mk.corners[2], mk.corners[4], mk.corners[6]]);
      const ys = markers.flatMap((mk) => [mk.corners[1], mk.corners[3], mk.corners[5], mk.corners[7]]);
      const sides = markers.map((mk) => mk.side).sort((p, q) => p - q);
      boxes.set(memory, { t, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), side: sides[Math.floor(sides.length / 2)], small: sides[Math.floor(sides.length * 0.1)] });
    } else boxes.delete(memory);
  }
  return markers;
}

// thorough: 精密解析（時間をかけてよい）。二値化の窓を細かく試す（THOROUGH_PARAMS）
// opts.reread: 読めなかったマスを読み直す数（省略時はライブ 4・精密解析は全部）、opts.focus: 先に読み直すマス（slot * 9 + cell）、
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
  opts: { reread?: number; focus?: number[]; colorFill?: boolean; idTrack?: boolean; region?: boolean; design?: string; turn?: boolean; shrink?: boolean } = {},
): FrameResult {
  const design = designOf(opts.design ?? STANDARD_DESIGN.key);
  if (!bench || bench.cv !== cv || bench.scheme !== scheme || bench.thorough !== thorough || bench.design !== design) {
    bench?.b.delete();
    const config = thorough ? { ...DEFAULT_CONFIGS[1], params: THOROUGH_PARAMS } : DEFAULT_CONFIGS[1]; // max(RGB)
    bench = { cv, scheme, thorough, design, b: new ArucoBench(cv, [config], scheme, design) };
  }
  const markers = detectMarkers(bench.b, img, t, memory, !!opts.region, opts.shrink === false || thorough ? Infinity : SHRINK_SIDE);
  const prev = tilts.get(memory);
  const r = reconstructFaces(markers, img, prev && t - prev.t < TILT_MS ? prev.tilt : null, scheme, undefined, true, design);
  if (r.faces.length) tilts.set(memory, { t, tilt: r.tilt });
  // 回転途中の形: 回している層が見えたら、その層が通る面の外側の 1 列を層の格子で置き、面から外れた層のマーカーもその列に入れる
  const tr = opts.turn === false || !r.faces.length ? null : recognizeTurnFor(markers, r.faces, img, t, memory, design);
  if (tr?.turn && tr.pose) applyTurnLayers(r.faces, tr, img, markers, scheme);
  const budget = opts.reread ?? (thorough ? 27 : 4);
  if (budget > 0 && r.faces.length) {
    if (!rereader || rereader.cv !== cv || rereader.scheme !== scheme || rereader.design !== design) {
      rereader?.b.delete();
      rereader = { cv, scheme, design, b: new ArucoBench(cv, [{ ...DEFAULT_CONFIGS[1], params: THOROUGH_PARAMS }], scheme, design) };
    }
    let rm = rereads.get(memory);
    if (!rm) rereads.set(memory, (rm = new Map()));
    rereadFaces(rereader.b, img, r.faces, scheme, budget, new Set(opts.focus ?? []), rm);
  }
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
  const quads: Pt[][] = markers.map((m) => [0, 1, 2, 3].map((i) => [m.corners[i * 2], m.corners[i * 2 + 1]] as Pt));
  const faces: DetectedFace[] = r.faces.map((f) => {
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
      masked: new Array(9).fill(false),
      // 1 列・1 枚の面: 色は使うが、外枠は推定なので 3D の傾き（estimatePose）には使わない
      held: !!f.partial,
      ...(f.ids.some((id) => id >= 0) ? { ids: f.ids } : {}),
      ...(f.layer ? { layer: f.layer } : {}),
    };
  });
  // 普通のステッカーと同じく正面（スロット 2）を先頭に。面があれば必ず正面がある（reconstructFaces の frontAlways）
  const front = faces.find((f) => f.slot === 2);
  if (!front) return { faces: [], quads, turn };
  return { faces: [front, ...faces.filter((f) => f !== front)], quads, turn };
}

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

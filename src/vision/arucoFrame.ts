// ArUco ステッカー（各ステッカーに色付き ArUco マーカー。符号の種類は src/aruco/codes.ts）の認識。
// 色を読む代わりにマーカーの ID から色（センターの面）が確定するので、面の格子を探して色を読む代わりに
// マーカーから面を組み立て（src/aruco/cube.ts）、各セルの色を代表色の Lab にして返す。追跡・スキャン・精密解析は
// 普通のステッカーと同じ経路（FrameResult）で動く。
import { fillByColor, frameRefs, skinFraction } from "../aruco/colorFill";
import { IdTracker } from "../aruco/idTrack";
import { reconstructFaces, trustedColors } from "../aruco/cube";
import { ArucoBench, DEFAULT_CONFIGS, type Marker, THOROUGH_PARAMS } from "../aruco/detect";
import type { StickerScheme } from "../aruco/codes";
import { ARUCO_REFS } from "../aruco/palette";
import { rereadFaces } from "../aruco/reread";
import type { Lab } from "./color";
import type { Pt } from "./homography";
import type { DetectedFace, FrameResult } from "./pipeline";
import type { CV } from "./quads";
import type { PixelSource } from "./sampler";

let bench: { cv: CV; scheme: StickerScheme; thorough: boolean; b: ArucoBench } | null = null;
// 再認識（切り出したマス）用。二値化の窓を細かく試す
let rereader: { cv: CV; scheme: StickerScheme; b: ArucoBench } | null = null;
// フレームの間で引き継ぐキューブの傾き（面が 1 つしか見えないときの向きの決定に使う）。記憶の入れ物ごと
const tilts = new WeakMap<object, { t: number; tilt: number[] | null }>();
// ID なし追跡（読めなくなったマスに直前のステッカーを引き継ぐ）。記憶の入れ物ごと
const trackers = new WeakMap<object, IdTracker>();
const TILT_MS = 1000;
// 直前のフレームのマーカーの範囲（切り出して検出するため。記憶の入れ物ごと）
const boxes = new WeakMap<object, { t: number; x0: number; y0: number; x1: number; y1: number; side: number }>();
const REGION_MS = 200; // これより前のフレームの範囲は使わない
const REGION_MARGIN = 2.5; // 範囲を広げる量（マーカーの辺の倍数。キューブが少し動いても、回している層がはみ出しても入る）
const REGION_EDGE = 1; // 切り出しの縁からこれ（マーカーの辺の倍数）以内にマーカーがあれば、外にもあるかもしれないので全体でやり直す

// マーカーを検出する。region: 直前のフレームのマーカーの周りだけを切り出して検出する（精密解析。画像全体の何割かで済む）。
// 切り出しの縁の近くにマーカーがある（キューブが大きく動いた）・何も見つからないときは全体でやり直す
function detectMarkers(b: ArucoBench, img: PixelSource, t: number, memory: object, region: boolean): Marker[] {
  const prev = region ? boxes.get(memory) : undefined;
  let markers: Marker[] | null = null;
  if (prev && t - prev.t < REGION_MS && t > prev.t) {
    const m = REGION_MARGIN * prev.side;
    const x0 = Math.max(0, Math.floor(prev.x0 - m));
    const y0 = Math.max(0, Math.floor(prev.y0 - m));
    const x1 = Math.min(img.width, Math.ceil(prev.x1 + m));
    const y1 = Math.min(img.height, Math.ceil(prev.y1 + m));
    if ((x1 - x0) * (y1 - y0) < img.width * img.height * 0.8) {
      const found = b.detect(img, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 })[0].markers;
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
      boxes.set(memory, { t, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), side: sides[Math.floor(sides.length / 2)] });
    } else boxes.delete(memory);
  }
  return markers;
}

// thorough: 精密解析（時間をかけてよい）。二値化の窓を細かく試す（THOROUGH_PARAMS）
// opts.reread: 読めなかったマスを読み直す数（省略時はライブ 4・精密解析は全部）、opts.focus: 先に読み直すマス（slot * 9 + cell）、
// opts.colorFill: それでも読めなかったマスを色で補う（既定 true。src/aruco/colorFill.ts）、
// opts.idTrack: ID が読めなかったマスに直前のフレームのステッカーを引き継ぐ（既定 true。src/aruco/idTrack.ts）、
// opts.region: 直前のフレームのマーカーの周りだけで検出する（精密解析。既定 false）
export function processAruco(
  cv: CV,
  img: PixelSource,
  t: number,
  memory: object,
  scheme: StickerScheme = "aruco54",
  thorough = false,
  opts: { reread?: number; focus?: number[]; colorFill?: boolean; idTrack?: boolean; region?: boolean } = {},
): FrameResult {
  if (!bench || bench.cv !== cv || bench.scheme !== scheme || bench.thorough !== thorough) {
    bench?.b.delete();
    const config = thorough ? { ...DEFAULT_CONFIGS[1], params: THOROUGH_PARAMS } : DEFAULT_CONFIGS[1]; // max(RGB)
    bench = { cv, scheme, thorough, b: new ArucoBench(cv, [config], scheme) };
  }
  const markers = detectMarkers(bench.b, img, t, memory, !!opts.region);
  const prev = tilts.get(memory);
  const r = reconstructFaces(markers, img, prev && t - prev.t < TILT_MS ? prev.tilt : null, scheme, undefined, true);
  if (r.faces.length) tilts.set(memory, { t, tilt: r.tilt });
  const budget = opts.reread ?? (thorough ? 27 : 4);
  if (budget > 0 && r.faces.length) {
    if (!rereader || rereader.cv !== cv || rereader.scheme !== scheme) {
      rereader?.b.delete();
      rereader = { cv, scheme, b: new ArucoBench(cv, [{ ...DEFAULT_CONFIGS[1], params: THOROUGH_PARAMS }], scheme) };
    }
    rereadFaces(rereader.b, img, r.faces, scheme, budget, new Set(opts.focus ?? []));
  }
  // 色による補完: 読めたマーカー（ID から色が分かる）の写った色を、そのフレームの色の基準にする
  if (opts.colorFill !== false && r.faces.length) fillByColor(img, r.faces, frameRefs(trustedColors(markers, scheme)));
  // ID なし追跡: 色で補ったマス（色が合えば）と読めなかったマスに、直前のフレームの同じマスのステッカーを引き継ぐ
  if (opts.idTrack !== false) {
    let tracker = trackers.get(memory);
    if (!tracker) trackers.set(memory, (tracker = new IdTracker()));
    const bySlot = new Map(r.faces.map((f) => [f.slot, f]));
    tracker.update(t, r.faces, null, (slot, cell) => skinFraction(img, bySlot.get(slot)!.H, cell) > 0.15);
  }
  const quads: Pt[][] = markers.map((m) => [0, 1, 2, 3].map((i) => [m.corners[i * 2], m.corners[i * 2 + 1]] as Pt));
  const faces: DetectedFace[] = r.faces.map((f) => {
    const known = f.colors.map((c) => c >= 0);
    return {
      slot: f.slot,
      rot: 0,
      H: f.H,
      found: known.filter(Boolean).length,
      labs: f.colors.map((c) => (c >= 0 ? ([...ARUCO_REFS[c]] as Lab) : ([0, 0, 0] as Lab))),
      spread: new Array(9).fill(0),
      valid: known,
      // 読みの確からしさ（マーカーの fit。読み直したマスは少し弱い: src/aruco/reread.ts）
      weight: f.conf,
      masked: new Array(9).fill(false),
      // 1 列・1 枚の面: 色は使うが、外枠は推定なので 3D の傾き（estimatePose）には使わない
      held: !!f.partial,
      ...(f.ids.some((id) => id >= 0) ? { ids: f.ids } : {}),
    };
  });
  // 普通のステッカーと同じく正面（スロット 2）を先頭に。面があれば必ず正面がある（reconstructFaces の frontAlways）
  const front = faces.find((f) => f.slot === 2);
  if (!front) return { faces: [], quads };
  return { faces: [front, ...faces.filter((f) => f !== front)], quads };
}

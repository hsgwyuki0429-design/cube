// ArUco ステッカー（各ステッカーに色付き ArUco マーカー。符号の種類は src/aruco/codes.ts）の認識。
// 色を読む代わりにマーカーの ID から色（センターの面）が確定するので、面の格子を探して色を読む代わりに
// マーカーから面を組み立て（src/aruco/cube.ts）、各セルの色を代表色の Lab にして返す。追跡・スキャン・精密解析は
// 普通のステッカーと同じ経路（FrameResult）で動く。
import { reconstructFaces } from "../aruco/cube";
import { ArucoBench, DEFAULT_CONFIGS, THOROUGH_PARAMS } from "../aruco/detect";
import type { StickerScheme } from "../aruco/codes";
import { ARUCO_REFS } from "../aruco/palette";
import type { Lab } from "./color";
import type { Pt } from "./homography";
import type { DetectedFace, FrameResult } from "./pipeline";
import type { CV } from "./quads";
import type { PixelSource } from "./sampler";

let bench: { cv: CV; scheme: StickerScheme; thorough: boolean; b: ArucoBench } | null = null;
// フレームの間で引き継ぐキューブの傾き（面が 1 つしか見えないときの向きの決定に使う）。記憶の入れ物ごと
const tilts = new WeakMap<object, { t: number; tilt: number[] | null }>();
const TILT_MS = 1000;

// thorough: 精密解析（時間をかけてよい）。二値化の窓を細かく試す（THOROUGH_PARAMS）
export function processAruco(cv: CV, img: PixelSource, t: number, memory: object, scheme: StickerScheme = "aruco54", thorough = false): FrameResult {
  if (!bench || bench.cv !== cv || bench.scheme !== scheme || bench.thorough !== thorough) {
    bench?.b.delete();
    const config = thorough ? { ...DEFAULT_CONFIGS[1], params: THOROUGH_PARAMS } : DEFAULT_CONFIGS[1]; // max(RGB)
    bench = { cv, scheme, thorough, b: new ArucoBench(cv, [config], scheme) };
  }
  const markers = bench.b.detect(img)[0].markers;
  const prev = tilts.get(memory);
  const r = reconstructFaces(markers, img, prev && t - prev.t < TILT_MS ? prev.tilt : null, scheme, undefined, true);
  if (r.faces.length) tilts.set(memory, { t, tilt: r.tilt });
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
      weight: new Array(9).fill(1),
      masked: new Array(9).fill(false),
      // 1 列・1 枚の面: 色は使うが、外枠は推定なので 3D の傾き（estimatePose）には使わない
      held: !!f.partial,
    };
  });
  // 普通のステッカーと同じく正面（スロット 2）を先頭に。面があれば必ず正面がある（reconstructFaces の frontAlways）
  const front = faces.find((f) => f.slot === 2);
  if (!front) return { faces: [], quads };
  return { faces: [front, ...faces.filter((f) => f !== front)], quads };
}

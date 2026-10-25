// リアルタイムの追跡を速くする: キューブを見つけた後は、直前のフレームでキューブがあった辺りだけを切り出し、
// セルの間隔が TARGET_PITCH px 程度になるよう縮小してから認識する（物体追跡でよく使う「関心領域」の考え方）。
// キューブが大きく写るほど画素が減る。見つからなければ全体でやり直す。結果の座標は元の画像に戻して返す
import { type Mat3, type Pt, applyH, invertH, mulH } from "./homography";
import { slotPoint } from "./layout";
import { type FrameResult, type PipelineConfig, type PipelineMemory, processFrame } from "./pipeline";
import type { CV } from "./quads";
import type { PixelSource } from "./sampler";
import type { Lab } from "./color";

const TARGET_PITCH = 44; // 縮小後のセルの間隔（px）。四角形の検出が安定する大きさ
const MARGIN = 1.6; // 直前の面の外形からこのセル数だけ広げて切り出す（フレーム間の移動・回転を見込む）
const RECENT_MS = 250; // 直前の面がこれより古ければ全体を見る
const MIN_SIDE = 160; // 切り出しが小さすぎると四角形の検出の前提（面積の割合）が崩れる
// 全体を見るときの溝の候補でのやり直し（1 フレーム 150〜200ms かかる）はこの間隔に 1 回だけ。ステッカーレスのキューブは
// やり直さないと見つからず、見つからないと切り出しが始まらない。見つかった後は切り出しの中でやり直す
const GROOVE_EVERY_MS = 400;

export interface RoiStats {
  roi: boolean; // 切り出して処理したか
  pixels: number; // 処理した画素数
}

// 直前の面の外形を囲む範囲（元の画像の座標）
function lastBounds(last: PipelineMemory, width: number, height: number): [number, number, number, number] | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const f of last.faces)
    for (const [x, y] of [
      [0, 0],
      [3, 0],
      [3, 3],
      [0, 3],
    ]) {
      const p = slotPoint(f, x, y);
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
      xs.push(p[0]);
      ys.push(p[1]);
    }
  if (!xs.length) return null;
  const m = last.pitch * MARGIN;
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - m));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - m));
  const x1 = Math.min(width, Math.ceil(Math.max(...xs) + m));
  const y1 = Math.min(height, Math.ceil(Math.max(...ys) + m));
  return x1 - x0 > 8 && y1 - y0 > 8 ? [x0, y0, x1, y1] : null;
}

// 切り出して縮小（縮小率に応じた箱型の平均で、細かい模様が折り返さないように）
function cropScale(img: PixelSource, [x0, y0, x1, y1]: [number, number, number, number], s: number): { data: Uint8ClampedArray; width: number; height: number } {
  const w = Math.max(1, Math.round((x1 - x0) * s));
  const h = Math.max(1, Math.round((y1 - y0) * s));
  const out = new Uint8ClampedArray(w * h * 4);
  const step = 1 / s;
  const box = Math.max(1, Math.floor(step));
  const src = img.data;
  const W = img.width;
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - box, Math.floor(y0 + y * step));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(W - box, Math.floor(x0 + x * step));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < box; dy++) {
        let k = ((sy + dy) * W + sx) * 4;
        for (let dx = 0; dx < box; dx++, k += 4) {
          r += src[k];
          g += src[k + 1];
          b += src[k + 2];
        }
      }
      const n = box * box;
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

const mapPt = (A: Mat3, p: Pt): Pt => applyH(A, p[0], p[1]);

export function processTracked(
  cv: CV | null,
  img: PixelSource,
  t: number,
  config: PipelineConfig,
  memory: { last: PipelineMemory | null; grooveT?: number },
  refs: Lab[] | null,
  hands: Pt[][] = [],
  stats?: RoiStats,
): FrameResult {
  // ArUco: マーカーは小さいので切り出して縮めず、全体で読む
  if (config.stickers === "aruco") return processFrame(cv, img, t, config, memory, refs, hands);
  const last = memory.last;
  const bounds = cv && config.mode === "auto" && last && t - last.t < RECENT_MS && last.faces.length ? lastBounds(last, img.width, img.height) : null;
  if (bounds) {
    const s = Math.min(1, TARGET_PITCH / Math.max(1, last!.pitch));
    const [x0, y0, x1, y1] = bounds;
    if ((x1 - x0) * s >= MIN_SIDE && (y1 - y0) * s >= MIN_SIDE) {
      // 元の画像 → 切り出し の変換
      const A: Mat3 = [s, 0, -s * x0, 0, s, -s * y0, 0, 0, 1];
      const Ai = invertH(A);
      const crop = cropScale(img, bounds, s);
      const mem2: { last: PipelineMemory | null } = {
        last: { ...last!, pitch: last!.pitch * s, faces: last!.faces.map((f) => ({ ...f, H: mulH(A, f.H) })) },
      };
      // 切り出しは小さいので、面が見つからないときの溝の候補でのやり直しもここでは許す。
      // フレームに対する割合のしきい値と姿勢の計算は、フレーム全体（切り出しの座標で）を基準にする
      const frame = { width: img.width * s, height: img.height * s, ox: -s * x0, oy: -s * y0 };
      const r = processFrame(cv, crop, t, { ...config, grooveRetry: true, frame }, mem2, refs, hands.map((hull) => hull.map((p) => mapPt(A, p))));
      if (r.faces.some((f) => !f.held)) {
        if (stats) (stats.roi = true), (stats.pixels = crop.width * crop.height);
        memory.last = mem2.last && mem2.last !== last ? { ...mem2.last, pitch: mem2.last.pitch / s, faces: mem2.last.faces.map((f) => ({ ...f, H: mulH(Ai, f.H) })) } : memory.last;
        return {
          ...r,
          faces: r.faces.map((f) => ({ ...f, H: mulH(Ai, f.H) })),
          quads: r.quads.map((q) => q.map((p) => mapPt(Ai, p))),
        };
      }
    }
  }
  if (stats) (stats.roi = false), (stats.pixels = img.width * img.height);
  const groove = config.grooveRetry || !(t - (memory.grooveT ?? -Infinity) < GROOVE_EVERY_MS);
  const r = processFrame(cv, img, t, groove ? { ...config, grooveRetry: true } : config, memory, refs, hands);
  // やり直しが要った（溝なしでは見つからなかった）ときだけ間隔を空ける
  if (groove && !config.grooveRetry && !r.faces.some((f) => !f.held)) memory.grooveT = t;
  return r;
}

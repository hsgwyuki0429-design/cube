/**
 * 認識 Worker。ピクセル → セル平均 → Lab までを担当する。
 *
 * CLAUDE.md アーキテクチャ原則 §4: 認識処理は最初から Worker + OffscreenCanvas に置く。
 * 分類・追跡はここではやらない（メインスレッド側の純粋モジュールで行い、
 * リプレイと回帰テストで同じコードを再利用できるようにするため）。
 */

import { rgbToLab } from './color';
import type {
  WorkerRequest, WorkerResponse, WorkerRoiConfig, RoiSample, TrackedRoiConfig, FrameTiming,
} from './types';
import { CubeTracker, trackedCellSamplePoints } from '../tracking/cubeTracker';
import type { CubeTrackingState, InitHint } from '../tracking/types';
import { rgbaToGray, type GrayImage } from '../tracking/opticalFlow';

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let rois: WorkerRoiConfig[] = [];
let procWidth = 480;

// --- 姿勢追跡 ---
// 追跡は Worker 側に置く。メインスレッドでやると同じフレームをもう一度
// フル解像度で読み戻す必要があり、二重コストになるため。
let tracker: CubeTracker | null = null;
let trackingEnabled = false;
let trackedRois: TrackedRoiConfig[] = [];
let trackedSamplesPerAxis = 4;
let pendingInit: InitHint | null = null;
/**
 * グレースケールのダブルバッファ。
 *
 * buildPyramid はレベル0を**参照で**保持するので、同じバッファを使い回すと
 * 前フレームのピラミッドの中身が今フレームで上書きされ、
 * オプティカルフローが同一画像同士を比較することになる。
 * 毎フレーム確保すると GC を叩くので2枚で回す。
 */
const grayBuffers: (GrayImage | null)[] = [null, null];
let grayIndex = 0;

/** sRGB(0..255) → 線形 の LUT。平均は線形空間で取る（ガンマ空間の平均は暗側に寄る）。 */
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  LIN[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, c * 255));
}

function post(msg: WorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(msg, transfer);
}

function ensureCanvas(w: number, h: number): void {
  if (!canvas || canvas.width !== w || canvas.height !== h) {
    canvas = new OffscreenCanvas(w, h);
    ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
  }
}

function sampleRoi(
  cfg: WorkerRoiConfig,
  data: Uint8ClampedArray,
  w: number,
  h: number,
): RoiSample {
  const perCell = cfg.samplesPerAxis * cfg.samplesPerAxis;
  const lab = new Float32Array(27);
  const rgb = new Float32Array(27);
  const tmp: [number, number, number] = [0, 0, 0];
  for (let cell = 0; cell < 9; cell++) {
    let lr = 0;
    let lg = 0;
    let lb = 0;
    for (let s = 0; s < perCell; s++) {
      const base = (cell * perCell + s) * 2;
      let px = Math.round(cfg.samples[base] * w);
      let py = Math.round(cfg.samples[base + 1] * h);
      if (px < 0) px = 0;
      else if (px >= w) px = w - 1;
      if (py < 0) py = 0;
      else if (py >= h) py = h - 1;
      const o = (py * w + px) * 4;
      lr += LIN[data[o]];
      lg += LIN[data[o + 1]];
      lb += LIN[data[o + 2]];
    }
    const r = linearToSrgb(lr / perCell);
    const g = linearToSrgb(lg / perCell);
    const b = linearToSrgb(lb / perCell);
    rgb[cell * 3] = r;
    rgb[cell * 3 + 1] = g;
    rgb[cell * 3 + 2] = b;
    rgbToLab(r, g, b, tmp);
    lab[cell * 3] = tmp[0];
    lab[cell * 3 + 1] = tmp[1];
    lab[cell * 3 + 2] = tmp[2];
  }
  return { lab, rgb };
}

/** 追跡された面から ROI サンプルを作る。既存の手動 ROI と同じ形で返す。 */
function sampleTrackedRois(
  tk: CubeTracker,
  state: CubeTrackingState,
  data: Uint8ClampedArray,
  w: number,
  h: number,
): RoiSample[] {
  const homographies = tk.faceHomography;
  const out: RoiSample[] = [];
  for (const cfg of trackedRois) {
    if (!cfg.enabled) continue;
    const H = homographies[cfg.faceId];
    const face = state.faces.find((f) => f.id === cfg.faceId);
    const usable = !!H && !!face && face.visible && state.status !== 'LOST';
    if (!usable) {
      // 見失っている面は色を読まない。誤った位置の色を下流へ流すと
      // 状態機械を壊す（CLAUDE.md 原則 §3）。
      out.push({ lab: new Float32Array(27), rgb: new Float32Array(27), trusted: false });
      continue;
    }
    const samples = trackedCellSamplePoints(
      H!, w, h, trackedSamplesPerAxis, tk.config.cellSampleInset, cfg.rotate, cfg.mirror,
    );
    const sample = sampleRoi({ samples, samplesPerAxis: trackedSamplesPerAxis }, data, w, h);
    sample.trusted = true;
    out.push(sample);
  }
  return out;
}

/**
 * 追跡状態のピクセル座標を正規化画像座標へ直す。
 * 再投影誤差は診断用なので px のまま残す。
 */
function normalizeState(s: CubeTrackingState, w: number, h: number): CubeTrackingState {
  return {
    ...s,
    faces: s.faces.map((f) => ({
      ...f,
      corners: f.corners.map((p) => ({ x: p.x / w, y: p.y / h })) as typeof f.corners,
    })),
    points: s.points.map((p) => ({
      ...p, x: p.x / w, y: p.y / h, px: p.px / w, py: p.py / h,
    })),
  };
}

/** 正規化画像座標で来たヒントを、処理解像度のピクセル座標へ直す。 */
function denormalizeHint(hint: InitHint, w: number, h: number): InitHint {
  const pt = (p: { x: number; y: number }) => ({ x: p.x * w, y: p.y * h });
  const out: InitHint = { kind: hint.kind };
  if (hint.point) out.point = pt(hint.point);
  if (hint.radius !== undefined) out.radius = hint.radius * Math.min(w, h);
  if (hint.box) {
    out.box = { x: hint.box.x * w, y: hint.box.y * h, w: hint.box.w * w, h: hint.box.h * h };
  }
  if (hint.corners) out.corners = hint.corners.map(pt) as InitHint['corners'];
  if (hint.quads) out.quads = hint.quads.map((q) => q.map(pt) as typeof q);
  return out;
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'config') {
      rois = msg.rois;
      procWidth = msg.procWidth;
      post({ type: 'ready' });
      return;
    }
    if (msg.type === 'trackingConfig') {
      trackingEnabled = msg.enabled;
      trackedRois = msg.rois;
      trackedSamplesPerAxis = msg.samplesPerAxis;
      if (!tracker) tracker = new CubeTracker(msg.config);
      else tracker.config = msg.config;
      tracker.collectPoints = msg.collectPoints;
      post({ type: 'ready' });
      return;
    }
    if (msg.type === 'initTracking') {
      pendingInit = msg.hint;
      return;
    }
    if (msg.type === 'resetTracking') {
      tracker?.reset();
      pendingInit = null;
      return;
    }
    if (msg.type === 'frame') {
      const t0 = performance.now();
      const bmp = msg.bitmap;
      const scale = procWidth / bmp.width;
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      ensureCanvas(w, h);
      ctx!.drawImage(bmp, 0, 0, w, h);
      bmp.close();
      const img = ctx!.getImageData(0, 0, w, h);

      const timing: FrameTiming = { samplingMs: 0, trackingMs: 0, flowMs: 0, homographyMs: 0 };
      let trackingState: CubeTrackingState | undefined;
      let out: RoiSample[];

      if (trackingEnabled && tracker) {
        const tTrack = performance.now();
        grayIndex ^= 1;
        const grayBuf = rgbaToGray(img.data, w, h, grayBuffers[grayIndex] ?? undefined);
        grayBuffers[grayIndex] = grayBuf;
        if (pendingInit) {
          const hint = denormalizeHint(pendingInit, w, h);
          const ok = tracker.initialize(grayBuf, hint, msg.t);
          post({ type: 'trackingInit', ok, reason: tracker.snapshot().reason });
          pendingInit = null;
        }
        // 追跡は処理解像度のピクセル座標で動くが、外へは正規化画像座標で返す。
        // ROI・オーバーレイ・録画は全て正規化座標で統一されているため。
        trackingState = normalizeState(tracker.step(grayBuf, msg.t), w, h);
        timing.trackingMs = performance.now() - tTrack;
        timing.flowMs = tracker.timing.flowMs;
        timing.homographyMs = tracker.timing.homographyMs;

        const tSample = performance.now();
        out = sampleTrackedRois(tracker, trackingState, img.data, w, h);
        timing.samplingMs = performance.now() - tSample;
      } else {
        const tSample = performance.now();
        out = rois.map((r) => sampleRoi(r, img.data, w, h));
        timing.samplingMs = performance.now() - tSample;
      }

      const transfer: Transferable[] = [];
      for (const r of out) transfer.push(r.lab.buffer, r.rgb.buffer);
      post(
        {
          type: 'result',
          frame: {
            seq: msg.seq, t: msg.t, procMs: performance.now() - t0, rois: out,
            tracking: trackingState, timing,
          },
        },
        transfer,
      );
    }
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};

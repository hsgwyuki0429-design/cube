/**
 * 認識 Worker。ピクセル → セル平均 → Lab までを担当する。
 *
 * CLAUDE.md アーキテクチャ原則 §4: 認識処理は最初から Worker + OffscreenCanvas に置く。
 * 分類・追跡はここではやらない（メインスレッド側の純粋モジュールで行い、
 * リプレイと回帰テストで同じコードを再利用できるようにするため）。
 */

import { rgbToLab } from './color';
import type { WorkerRequest, WorkerResponse, WorkerRoiConfig, RoiSample } from './types';

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let rois: WorkerRoiConfig[] = [];
let procWidth = 480;

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

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'config') {
      rois = msg.rois;
      procWidth = msg.procWidth;
      post({ type: 'ready' });
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
      const out: RoiSample[] = rois.map((r) => sampleRoi(r, img.data, w, h));
      const transfer: Transferable[] = [];
      for (const r of out) transfer.push(r.lab.buffer, r.rgb.buffer);
      post(
        {
          type: 'result',
          frame: { seq: msg.seq, t: msg.t, procMs: performance.now() - t0, rois: out },
        },
        transfer,
      );
    }
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};

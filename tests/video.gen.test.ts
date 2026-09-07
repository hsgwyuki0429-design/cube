/**
 * ブラウザ統合テスト用の合成キューブ動画（Y4M）を生成する。
 *   npm run video
 *
 * Chromium の --use-file-for-fake-video-capture に食わせると、
 * 実際のカメラ経路（getUserMedia → rVFC → createImageBitmap → Worker）を
 * 通して追跡を検証できる。ファイルが大きいのでリポジトリには入れない。
 */
import { it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { renderFrame, defaultCamera, defaultPose } from '../src/dev/cubeRender';
import { makeRng } from '../src/core/cube';

const enabled = process.env.GEN_VIDEO === '1';
const TAU = Math.PI * 2;

/** RGBA -> YUV420 planar (BT.601)。Y4M のフレーム本体。 */
function rgbaToYuv420(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h + (w * h) / 2);
  const uOff = w * h;
  const vOff = uOff + (w * h) / 4;
  const cw = w >> 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
      out[y * w + x] = Math.max(16, Math.min(235, 16 + (65.738 * r + 129.057 * g + 25.064 * b) / 256));
      if ((x & 1) === 0 && (y & 1) === 0) {
        const ci = (y >> 1) * cw + (x >> 1);
        out[uOff + ci] = Math.max(16, Math.min(240, 128 + (-37.945 * r - 74.494 * g + 112.439 * b) / 256));
        out[vOff + ci] = Math.max(16, Math.min(240, 128 + (112.439 * r - 94.154 * g - 18.285 * b) / 256));
      }
    }
  }
  return out;
}

it.skipIf(!enabled)('合成キューブ動画を書き出す', { timeout: 300000 }, () => {
  const path = process.env.VIDEO_OUT ?? '/tmp/cube-motion.y4m';
  const frames = Number(process.env.VIDEO_FRAMES ?? 240);
  const fps = Number(process.env.VIDEO_FPS ?? 30);
  const cam = defaultCamera(480, 360);
  const base = defaultPose();
  const rng = makeRng(99);

  const chunks: Uint8Array[] = [];
  const header = `YUV4MPEG2 W${cam.width} H${cam.height} F${fps}:1 Ip A1:1 C420\n`;
  chunks.push(new TextEncoder().encode(header));
  const frameTag = new TextEncoder().encode('FRAME\n');

  // 先頭は静止させる。ブラウザ側でカメラ開始→初期化までに時間がかかるため、
  // 既知の姿勢のまま初期化できる区間を作っておく。
  const lead = Number(process.env.VIDEO_LEAD ?? 120);

  for (let i = 0; i < frames; i++) {
    if (i < lead) {
      const f0 = renderFrame(base, cam, { rng, noise: 3 });
      chunks.push(frameTag);
      chunks.push(rgbaToYuv420(f0.rgba, f0.width, f0.height));
      continue;
    }
    const k = i - lead;
    // 平行移動 → 拡大縮小 → 回転 → 透視変化 を順に含む
    const pose = {
      ...base,
      tx: base.tx + 1.3 * Math.sin((k / 70) * TAU),
      ty: base.ty + 0.5 * (Math.cos((k / 55) * TAU) - 1),
      tz: base.tz * (1 + 0.2 * Math.sin((k / 90) * TAU)),
      rx: base.rx + 0.15 * Math.sin((k / 80) * TAU),
      ry: base.ry + 0.18 * (Math.cos((k / 65) * TAU) - 1),
      rz: base.rz + 0.12 * Math.sin((k / 45) * TAU),
    };
    const f = renderFrame(pose, cam, { rng, noise: 3 });
    chunks.push(frameTag);
    chunks.push(rgbaToYuv420(f.rgba, f.width, f.height));
  }

  const total = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
  console.log(`${path}: ${frames} frames, ${(total / 1e6).toFixed(1)} MB`);
  expect(total).toBeGreaterThan(1000);
});

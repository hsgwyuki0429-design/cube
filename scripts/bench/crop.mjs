// 録画の切り出しの効果を測る材料: 動画を「画面全体 1280」「1280 から切り出し」「元の解像度から切り出し」で圧縮する（x264・-threads 1）。
//   node scripts/bench/crop.mjs <動画> <出力.mp4> <full|crop1280|croporig> <ビットレート kbps> <ずらすフレーム数> <原画質の読み(.read.json)>
// 切り出す範囲は、直前に読めた面の外枠（原画質の動画全体の精密解析の読み）を囲む正方形。大きさは動画ごとに固定（読めた面の大きさの中央値 ×
// SIZE_K、480〜720。元の解像度では 1.5 倍）。真ん中は読みの真ん中をゆっくり追い（1 フレームに FOLLOW）、大きさの RECENTER より離れたら作り直す
// （跳ぶ）。ずらすフレーム数 k: 最初の k フレームを捨て、時刻は元のまま（-output_ts_offset）にする（同じ動画の圧縮を k で変える）。
// 切り出した位置は <出力>.crop.json（フレームごとの左上）に残す
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [video, out, mode, kbps, shiftArg, readsFile] = process.argv.slice(2);
const shift = Number(shiftArg);
export const SIZE_K = 1.8;
const FOLLOW = 0.05;
const RECENTER = 0.25;
const W0 = 1280;
const H0 = 720;
const native = mode === "croporig";
const scale = native ? 1.5 : 1; // 1280 の座標 → 出力の元の座標
const srcW = native ? 1920 : W0;
const srcH = native ? 1080 : H0;

// 読みの面の外枠 → フレームごとの囲み（1280 の座標）
const reads = JSON.parse(readFileSync(readsFile, "utf8")).readings;
const boxes = [];
for (const r of reads) {
  const qs = r.faces.filter((f) => f.quad && f.quad.length === 8).map((f) => f.quad);
  if (!qs.length) continue;
  const xs = qs.flatMap((q) => [q[0], q[2], q[4], q[6]]);
  const ys = qs.flatMap((q) => [q[1], q[3], q[5], q[7]]);
  boxes.push({ t: r.t, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
}
const ext = boxes.map((b) => Math.max(b.x1 - b.x0, b.y1 - b.y0)).sort((a, b) => a - b);
const med = ext[Math.floor(ext.length / 2)];
const good = boxes.filter((b) => Math.max(b.x1 - b.x0, b.y1 - b.y0) < 2 * med && b.x0 > -50 && b.x1 < W0 + 50 && b.y0 > -50 && b.y1 < H0 + 50);
const S1280 = Math.min(720, Math.max(480, 2 * Math.round((SIZE_K * med) / 2)));
const S = mode === "full" ? 0 : 2 * Math.round((S1280 * scale) / 2);
const outW = mode === "full" ? W0 : S;
const outH = mode === "full" ? H0 : S;

const dec = spawn("ffmpeg", ["-v", "error", "-i", video, ...(native ? [] : ["-vf", `scale=${W0}:-2`]), "-r", "60", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"]);
const enc = spawn("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", `${outW}x${outH}`, "-r", "60", "-i", "-", "-c:v", "libx264", "-profile:v", "baseline", "-preset", "veryfast", "-tune", "zerolatency", "-b:v", `${kbps}k`, "-maxrate", `${kbps}k`, "-bufsize", `${Number(kbps) / 2}k`, "-g", "60", "-pix_fmt", "yuv420p", "-threads", "1", "-output_ts_offset", String(shift / 60), out]);
enc.stderr.pipe(process.stderr);
dec.stderr.pipe(process.stderr);

const frameSize = (srcW * srcH * 3) / 2;
const outSize = (outW * outH * 3) / 2;
let buf = Buffer.alloc(0);
let n = 0;
let bi = 0;
let cx = null;
let cy = null;
const track = [];
function cropFrame(src, x0, y0) {
  const o = Buffer.alloc(outSize);
  // Y
  for (let y = 0; y < outH; y++) src.copy(o, y * outW, (y0 + y) * srcW + x0, (y0 + y) * srcW + x0 + outW);
  // U・V（半分）
  const cw = srcW / 2;
  const ow = outW / 2;
  for (let p = 0; p < 2; p++) {
    const sb = srcW * srcH + p * (cw * (srcH / 2));
    const ob = outW * outH + p * (ow * (outH / 2));
    for (let y = 0; y < outH / 2; y++) src.copy(o, ob + y * ow, sb + (y0 / 2 + y) * cw + x0 / 2, sb + (y0 / 2 + y) * cw + x0 / 2 + ow);
  }
  return o;
}
async function write(b) {
  if (!enc.stdin.write(b)) await new Promise((r) => enc.stdin.once("drain", r));
}
for await (const chunk of dec.stdout) {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= frameSize) {
    const f = buf.subarray(0, frameSize);
    buf = buf.subarray(frameSize);
    const t = (n * 1000) / 60;
    n++;
    if (n <= shift) continue;
    if (mode === "full") {
      await write(Buffer.from(f));
      continue;
    }
    // 直前に読めた囲み
    while (bi + 1 < good.length && good[bi + 1].t <= t) bi++;
    const b = good[bi];
    const tx = ((b.x0 + b.x1) / 2) * scale;
    const ty = ((b.y0 + b.y1) / 2) * scale;
    if (cx === null || Math.hypot(tx - cx, ty - cy) > RECENTER * S) {
      cx = tx;
      cy = ty;
    } else {
      cx += FOLLOW * (tx - cx);
      cy += FOLLOW * (ty - cy);
    }
    const x0 = 2 * Math.round(Math.min(srcW - S, Math.max(0, cx - S / 2)) / 2);
    const y0 = 2 * Math.round(Math.min(srcH - S, Math.max(0, cy - S / 2)) / 2);
    track.push([Math.round(t), x0, y0]);
    await write(cropFrame(f, x0, y0));
  }
}
enc.stdin.end();
await new Promise((r) => enc.on("close", r));
writeFileSync(`${out}.crop.json`, JSON.stringify({ mode, size: [outW, outH], scale, shift, median: med, track }));
console.log(`${out}: ${mode} ${outW}x${outH} ずらし ${shift} 面の大きさの中央値 ${med.toFixed(0)}`);

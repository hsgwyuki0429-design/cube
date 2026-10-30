// ArUco 検証ページの E2E 用の合成動画（240fps、テストページを左右に振る）を ffmpeg で作る。
//   ARUCO_VIDEO=out.mp4 [ARUCO_CODEC=vp9|h264] [ARUCO_ROTATE=90] npx vitest run -c vitest.debug.config.ts tests/debug/arucoVideo.debug.test.ts
// 0.5 秒止まる → 1.5 秒かけて振り幅 120px・1〜4Hz で振る（露光 1/480 秒のぶれ付き）→ 0.5 秒止まる
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { it } from "vitest";
import { initOpenCv } from "../../src/vision/image";
import { type RenderMarker, renderStickers } from "../arucoRender";

it("合成動画を書き出す", async () => {
  const out = process.env.ARUCO_VIDEO;
  if (!out) return;
  const codec = process.env.ARUCO_CODEC ?? "vp9";
  const rotate = process.env.ARUCO_ROTATE;
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const W = 1280;
  const H = 720;
  const FPS = 240;
  const N = Math.round(2.5 * FPS);
  const args = ["-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-"];
  if (codec === "h264") args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p");
  // 4:2:0（スマホの動画と同じ。rgb24 から作ると 4:4:4 になり、ヘッドレス Chromium の色変換が崩れる）
  else args.push("-c:v", "libvpx-vp9", "-b:v", "12M", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-pix_fmt", "yuv420p");
  const tmp = rotate ? `${out}.tmp.mp4` : out;
  args.push(tmp);
  const ff = spawn("ffmpeg", args, { stdio: ["pipe", "inherit", "inherit"] });
  const colors: [number, number, number][] = [
    [228, 228, 222],
    [190, 25, 35],
    [20, 65, 170],
  ];
  const ppm = 4;
  // 振り幅は両端で 0 に戻す（途中で飛ぶと、そのフレームだけ極端なぶれになる）。周波数は 1Hz → 4Hz
  const offset = (t: number) => {
    if (t < 0.5 || t > 2) return 0;
    const u = t - 0.5;
    return 120 * Math.sin((Math.PI * u) / 1.5) * Math.sin(2 * Math.PI * (u + u * u));
  };
  for (let i = 0; i < N; i++) {
    const t = i / FPS;
    const x = offset(t);
    const v = (offset(t + 1 / 960) - offset(t - 1 / 960)) * 480; // px/s
    const markers: RenderMarker[] = [];
    [12, 15, 18].forEach((mm, row) =>
      [90, 91, 92].forEach((id, col) => markers.push({ id, rgb: colors[col], cx: 440 + col * 200 + x, cy: 170 + row * 190, size: mm * ppm, dx: v / 480 })),
    );
    const img = renderStickers(cv, markers, { width: W, height: H, background: [32, 32, 34], noise: 2, seed: i + 1 });
    const rgb = Buffer.alloc(W * H * 3);
    for (let p = 0; p < W * H; p++) {
      rgb[p * 3] = img.data[p * 4];
      rgb[p * 3 + 1] = img.data[p * 4 + 1];
      rgb[p * 3 + 2] = img.data[p * 4 + 2];
    }
    if (!ff.stdin.write(rgb)) await new Promise((r) => ff.stdin.once("drain", r));
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("exit", r));
  if (rotate) {
    await new Promise((r) => spawn("ffmpeg", ["-loglevel", "error", "-y", "-display_rotation", rotate, "-i", tmp, "-c", "copy", out], { stdio: "inherit" }).on("exit", r));
  }
}, 600000);

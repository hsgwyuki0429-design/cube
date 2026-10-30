// キューブモードの E2E 用の合成動画: ArUco ステッカーを貼ったキューブを揃った状態から回す（240fps、約 10 手/秒、ぶれ付き）
//   ARUCO_VIDEO=out.mp4 [ARUCO_ALG="R U R' U'"] [ARUCO_SCHEME=aruco54] npx vitest run -c vitest.debug.config.ts tests/debug/arucoCubeVideo.debug.test.ts
//   ARUCO_START="スクランブル": 揃った状態からこれを回した状態から始める（タイマーの動画の E2E: scripts/video-e2e.mjs）
//   ARUCO_FILE_FPS=30: ファイルの時刻をこの fps にする（スロー再生用に書き出された動画。撮影は 240fps のまま）
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { it } from "vitest";
import type { StickerScheme } from "../../src/aruco/codes";
import { parseMoves } from "../../src/cube/model";
import { initOpenCv } from "../../src/vision/quads";
import { applyMoveStickers, renderArucoCube, solvedStickers } from "../arucoCube";

it("合成動画を書き出す", async () => {
  const out = process.env.ARUCO_VIDEO;
  if (!out) return;
  const tperm = "R U R' U' R' F R2 U' R' U' R U R' F'";
  const alg = process.env.ARUCO_ALG ?? `${tperm} ${tperm}`;
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const scheme = (process.env.ARUCO_SCHEME ?? "aruco12") as StickerScheme;
  const W = Number(process.env.ARUCO_W ?? 1280);
  const H = Number(process.env.ARUCO_H ?? 720);
  const FPS = 240;
  const TURN = 18; // 1 手を回すフレーム数（75ms）
  const PAUSE = 6; // 手と手の間（25ms）
  const fileFps = Number(process.env.ARUCO_FILE_FPS ?? FPS);
  const ff = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-r", String(fileFps), "-i", "-", "-c:v", "libvpx-vp9", "-b:v", "16M", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-pix_fmt", "yuv420p", out], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  let st = solvedStickers();
  for (const m of parseMoves(process.env.ARUCO_START ?? "")) st = applyMoveStickers(st, m);
  let n = 0;
  const write = async (turn?: { move: number; fraction: number; spread: number }) => {
    // 手の揺れ: 視点をゆっくり動かす
    const wob = Math.sin(n / 90) * 0.15;
    const img = renderArucoCube(cv, { width: W, height: H, stickers: st, orient: 0, eye: [2.4 + wob, 2.4, 5.5], turn, noise: 2, seed: n + 1, scheme });
    n++;
    const rgb = Buffer.alloc(W * H * 3);
    for (let p = 0; p < W * H; p++) {
      rgb[p * 3] = img.data[p * 4];
      rgb[p * 3 + 1] = img.data[p * 4 + 1];
      rgb[p * 3 + 2] = img.data[p * 4 + 2];
    }
    if (!ff.stdin.write(rgb)) await new Promise((r) => ff.stdin.once("drain", r));
  };
  const ease = (u: number) => u * u * (3 - 2 * u);
  for (let k = 0; k < 48; k++) await write();
  for (const m of parseMoves(alg)) {
    for (let k = 1; k < TURN; k++) {
      const a = ease((k - 0.5) / TURN);
      const b = ease((k + 0.5) / TURN);
      await write({ move: m, fraction: (a + b) / 2, spread: b - a });
    }
    st = applyMoveStickers(st, m);
    for (let k = 0; k < PAUSE; k++) await write();
  }
  for (let k = 0; k < 48; k++) await write();
  ff.stdin.end();
  await new Promise((r) => ff.on("exit", r));
  console.log("frames", n);
}, 3600000);

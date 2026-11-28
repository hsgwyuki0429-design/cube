// 偽のカメラ（Chromium の --use-file-for-fake-video-capture）に流す、タイマーの 1 回分の合成動画（y4m・60fps・1280×720）を作る。
// デモの合成カメラ（three.js をメインスレッドで描く）は E2E の Chromium（swiftshader）では 1 秒 15〜20 枚しか出ず、実機の 60fps の
// 重さを再現できない（ライブ 2.5: ソルブ中に fps が落ちる原因を調べる）。この動画なら、カメラのフレームは Chromium が別のスレッドで出す。
//   FAKE_OUT=out.y4m npx vitest run -c vitest.debug.config.ts tests/debug/fakeCamVideo.debug.test.ts
//   → E2E_FAKECAM=out.y4m E2E_MODE=timer npm run e2e（スクランブルは動画と同じものを URL の ?scramble= で渡す: 出力の 1 行目）
// 流れ: 揃った状態で FAKE_HOLD0 秒 → スクランブル（FAKE_SCRAMBLE。既定は乱数の 20 手。1 手 0.3 秒）→ インスペクション FAKE_INSPECT 秒
//   （少し傾ける）→ ソルブ（スクランブルを戻す手順に、往復する乱数の手 FAKE_EXTRA 手を足したもの。1 手 FAKE_SOLVE_MS）→ 揃った状態で FAKE_HOLD1 秒
// 撮り方の案内（src/app/captureAdvice.ts）の場面: FAKE_DIST（視点の距離の倍率。2 = 遠い）・FAKE_BRIGHT（明るさの倍率。0.35 = 暗い）・
//   FAKE_EYE="x,y,z"（視点。"0.3,6,1.2" = 真上から）・FAKE_SHIFT="x,y"（キューブを画面の中でずらす。キューブの座標で）・FAKE_ONLY=hold
//   （揃った状態のまま FAKE_HOLD0 秒だけ）・FAKE_DESIGN=standard（ステッカーのマーカーの配置。E2E は E2E_QUERY='&stickers=standard' で同じ配置に）
import { spawn } from "node:child_process";
import { it } from "vitest";
import { designOf } from "../../src/aruco/design";
import { MOVE_NAMES, inverseMove, moveFace, parseMoves } from "../../src/cube/model";
import { applyMoveStickers, renderArucoCube, solvedStickers } from "../arucoCube";
import { loadTestOpenCv } from "../cv";

it("偽のカメラの動画", async () => {
  const out = process.env.FAKE_OUT;
  if (!out) return;
  const cv = await loadTestOpenCv();
  const W = Number(process.env.FAKE_W ?? 1280);
  const H = Number(process.env.FAKE_H ?? 720);
  const FPS = 60;
  let seed = Number(process.env.FAKE_SEED ?? 7);
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const randomMoves = (n: number) => {
    const ms: number[] = [];
    while (ms.length < n) {
      const m = Math.floor(rnd() * 18);
      if (ms.length && moveFace(ms[ms.length - 1]) === moveFace(m)) continue;
      ms.push(m);
    }
    return ms;
  };
  const scramble = process.env.FAKE_SCRAMBLE ? parseMoves(process.env.FAKE_SCRAMBLE) : randomMoves(20);
  const extra = randomMoves(Number(process.env.FAKE_EXTRA ?? 10));
  const solve = [...extra, ...[...extra].reverse().map(inverseMove), ...[...scramble].reverse().map(inverseMove)];
  const only = process.env.FAKE_ONLY;
  console.log(`scramble=${encodeURIComponent(scramble.map((m) => MOVE_NAMES[m]).join(" "))}`);
  const dist = Number(process.env.FAKE_DIST ?? 1);
  const bright = Number(process.env.FAKE_BRIGHT ?? 1);
  const eye0 = (process.env.FAKE_EYE ?? "2.4,2.4,5.5").split(",").map(Number) as [number, number, number];
  const shift = (process.env.FAKE_SHIFT ?? "0,0").split(",").map(Number);
  const design = designOf(process.env.FAKE_DESIGN ?? "quad-half");
  const ff = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-", "-pix_fmt", "yuv420p", "-f", "yuv4mpegpipe", out], { stdio: ["pipe", "inherit", "inherit"] });
  let st = solvedStickers();
  let n = 0;
  const rgb = Buffer.alloc(W * H * 3);
  // 画素の雑音は表から（毎フレーム違う。止まっているときに同じ画素が続くと、精密解析が止まったフレームとして飛ばし、実物より軽くなる）
  const NOISE = 1 << 22;
  const noise = new Int8Array(NOISE);
  for (let i = 0; i < NOISE; i++) noise[i] = Math.round(Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd()) * 2);
  let base: Uint8ClampedArray | null = null;
  const write = async (turn?: { move: number; fraction: number; spread: number }, tilt = 0, reuse = false) => {
    // 手の揺れ: 視点をゆっくり動かす（インスペクションは tilt で大きめに）。reuse: 前の絵を使い回す（止まっているとき。3 枚に 1 回描く）
    if (!reuse || !base) {
      const wob = Math.sin(n / 90) * 0.15 + tilt;
      const eye: [number, number, number] = [(eye0[0] + wob) * dist, eye0[1] * dist, eye0[2] * dist];
      // ずらす: 見る点をキューブの反対へ（キューブが画面の端へ寄る）
      const target: [number, number, number] = [-shift[0], -shift[1], 0];
      base = renderArucoCube(cv, { width: W, height: H, stickers: st, orient: 0, eye, target, turn, noise: 0, scheme: "unique54", design, background: [70, 66, 62] }).data;
    }
    const off = Math.floor(rnd() * (NOISE - W * H * 3));
    for (let p = 0, q = 0; p < W * H * 3; p += 3, q += 4) {
      rgb[p] = Math.max(0, Math.min(255, base[q] * bright + noise[off + p]));
      rgb[p + 1] = Math.max(0, Math.min(255, base[q + 1] * bright + noise[off + p + 1]));
      rgb[p + 2] = Math.max(0, Math.min(255, base[q + 2] * bright + noise[off + p + 2]));
    }
    n++;
    if (!ff.stdin.write(rgb)) await new Promise((r) => ff.stdin.once("drain", r));
  };
  const ease = (u: number) => u * u * (3 - 2 * u);
  const turnFrames = async (moves: number[], turnMs: number, pauseMs: number) => {
    const TURN = Math.max(3, Math.round((turnMs / 1000) * FPS));
    const PAUSE = Math.round((pauseMs / 1000) * FPS);
    for (const m of moves) {
      for (let k = 1; k < TURN; k++) {
        const a = ease((k - 0.5) / TURN);
        const b = ease((k + 0.5) / TURN);
        await write({ move: m, fraction: (a + b) / 2, spread: b - a });
      }
      st = applyMoveStickers(st, m);
      for (let k = 0; k < PAUSE; k++) await write(undefined, 0, k % 3 !== 0);
    }
  };
  const hold = async (sec: number, tilt = 0) => {
    for (let k = 0; k < sec * FPS; k++) await write(undefined, tilt * Math.sin((k / FPS) * 1.5), k % 3 !== 0);
  };
  await hold(Number(process.env.FAKE_HOLD0 ?? 6));
  if (only !== "hold") {
    await turnFrames(scramble, 170, 130);
    await hold(Number(process.env.FAKE_INSPECT ?? 4), 0.4);
    const solveMs = Number(process.env.FAKE_SOLVE_MS ?? 250);
    await turnFrames(solve, solveMs * 0.6, solveMs * 0.4);
    await hold(Number(process.env.FAKE_HOLD1 ?? 20));
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("exit", r));
  console.log(`frames ${n}（${(n / FPS).toFixed(1)} 秒）・ソルブ ${solve.length} 手`);
}, 3600000);

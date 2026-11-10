// 実物の動画のフレームで、検出（OpenCV の ArucoDetector）の設定ごとの時間と読めたマーカーの数を比べる。
//   REAL_VIDEO=IMG_4972.MOV DET_EVERY=6 npx vitest run -c vitest.debug.config.ts tests/debug/detectSpeed.debug.test.ts --silent=false
import { spawn, spawnSync } from "node:child_process";
import { it } from "vitest";
import { ArucoBench, type ArucoParams, DEFAULT_CONFIGS } from "../../src/aruco/detect";
import { STICKERS, designOf } from "../../src/aruco/design";
import { stickerScheme } from "../../src/aruco/codes";
import { loadTestOpenCv } from "../cv";

it("検出の設定ごとの時間", async () => {
  const file = process.env.REAL_VIDEO;
  if (!file) return;
  const cv = await loadTestOpenCv();
  const [sw, sh] = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8" }).stdout.trim().split(",").map(Number);
  const s = 1280 / Math.max(sw, sh);
  const W = Math.round((sw * s) / 2) * 2;
  const H = Math.round((sh * s) / 2) * 2;
  const every = Number(process.env.DET_EVERY ?? 6);
  const variants: Record<string, Partial<ArucoParams>> = {
    "5-15": {},
    "5": { adaptiveThreshWinSizeMin: 5, adaptiveThreshWinSizeMax: 5 },
    "10": { adaptiveThreshWinSizeMin: 10, adaptiveThreshWinSizeMax: 10 },
    "15": { adaptiveThreshWinSizeMin: 15, adaptiveThreshWinSizeMax: 15 },
    "7,13": { adaptiveThreshWinSizeMin: 7, adaptiveThreshWinSizeMax: 13, adaptiveThreshWinSizeStep: 6 },
    ...JSON.parse(process.env.DET_VARIANTS ?? "{}"),
  };
  const scheme = stickerScheme(STICKERS.stickers);
  const design = designOf(STICKERS.arucoDesign!);
  const names = Object.keys(variants);
  // SMALL_WINDOWS（配置の既定）の後に上書きしたいので、検出器を作ってからパラメータを差し替える
  const benches = names.map((n) => {
    const b = new ArucoBench(cv as never, [DEFAULT_CONFIGS[1]], scheme, design);
    const bb = b as never as { params: Partial<ArucoParams>[]; rateScale: number; setRateScale(x: number): void };
    Object.assign(bb.params[0], variants[n]);
    bb.rateScale = -1;
    bb.setRateScale(1);
    return b;
  });
  const ms = names.map(() => 0);
  const found = names.map(() => 0);
  const stickers = names.map(() => 0);
  const sides: number[] = [];
  let frames = 0;
  const proc = spawn("ffmpeg", ["-v", "error", "-i", file, "-vf", `scale=${W}:${H}`, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
  const size = W * H * 4;
  let buf = Buffer.alloc(0);
  let k = 0;
  for await (const chunk of proc.stdout) {
    buf = Buffer.concat([buf, chunk as Buffer]);
    while (buf.length >= size) {
      const data = new Uint8ClampedArray(buf.subarray(0, size));
      buf = buf.subarray(size);
      if (k++ % every) continue;
      frames++;
      const img = { data, width: W, height: H };
      names.forEach((_, i) => {
        const a = performance.now();
        const r = benches[i].detect(img)[0].markers;
        ms[i] += performance.now() - a;
        found[i] += r.length;
        stickers[i] += new Set(r.map((m) => m.id)).size;
        if (i === 0) for (const m of r) sides.push(m.side);
      });
    }
  }
  sides.sort((a, b) => a - b);
  const q = (p: number) => sides[Math.floor(sides.length * p)]?.toFixed(1);
  console.log(`${frames} フレーム（${W}×${H}・画像全体）・マーカーの辺 10% ${q(0.1)} 中央 ${q(0.5)} 90% ${q(0.9)}`);
  names.forEach((n, i) => console.log(`${n.padEnd(8)} ${(ms[i] / frames).toFixed(1).padStart(6)}ms  マーカー ${(found[i] / frames).toFixed(1).padStart(5)}  ステッカー ${(stickers[i] / frames).toFixed(2)}（${((stickers[i] / stickers[0]) * 100).toFixed(0)}%）`));
}, 3600000);

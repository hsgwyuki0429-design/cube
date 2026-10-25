// 止まっているフレームを飛ばす（ソルブ中から精密解析を進めるとき、キューブも手も止まっている間に追いつくため）。
// 精密解析は 1 フレームに 0.2〜1 秒かかり、全フレームを処理すると実時間に追いつかない。間引くと速い手を読み違える
// （実際の動画で、30fps 相当にしただけで崩れた）ので、動いている間は全フレームを処理し、止まっている間だけ飛ばす。
// 動き出したら、飛ばした直前の 1 枚も処理する（回し始めの時刻を決めるのに、動く直前の静止フレームが要る）
import type { PixelSource } from "./sampler";

const GRID = 40; // 明るさを比べる点の数（縦横）
const STILL = 2.2; // 隣のフレームとの明るさの差の平均がこれ未満なら止まっている（0..255）
const KEEP_MS = 200; // 止まっていても、この間隔に 1 枚は処理する

function thumb(img: PixelSource): Float32Array {
  const out = new Float32Array(GRID * GRID);
  const { width: w, height: h, data } = img;
  for (let gy = 0; gy < GRID; gy++)
    for (let gx = 0; gx < GRID; gx++) {
      const x = Math.floor(((gx + 0.5) * w) / GRID);
      const y = Math.floor(((gy + 0.5) * h) / GRID);
      const k = (y * w + x) * 4;
      out[gy * GRID + gx] = (data[k] + data[k + 1] + data[k + 2]) / 3;
    }
  return out;
}

export class StillSkipper {
  private prev: Float32Array | null = null;
  private lastDone = -Infinity;
  private held: { img: PixelSource; t: number } | null = null; // 飛ばした直前のフレーム
  skipped = 0;

  // このフレームで処理するもの（0〜2 枚。時刻順）
  next<T extends PixelSource>(img: T, t: number): { img: T; t: number }[] {
    const cur = thumb(img);
    let diff = Infinity;
    if (this.prev) {
      let s = 0;
      for (let i = 0; i < cur.length; i++) s += Math.abs(cur[i] - this.prev[i]);
      diff = s / cur.length;
    }
    this.prev = cur;
    if (diff < STILL && t - this.lastDone < KEEP_MS) {
      this.held = { img: copy(img), t };
      this.skipped++;
      return [];
    }
    const out: { img: T; t: number }[] = [];
    if (this.held && diff >= STILL) out.push(this.held as { img: T; t: number });
    out.push({ img, t });
    this.held = null;
    this.lastDone = t;
    return out;
  }
}

// ImageData の幅・高さはプロトタイプのゲッターなので、展開せずに書き出す
function copy<T extends PixelSource>(img: T): T {
  return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height } as T;
}

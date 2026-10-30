// 止まっているフレームを飛ばす（ソルブ中から精密解析を進めるとき、キューブも手も止まっている間に追いつくため）。
// 精密解析は 1 フレームに 0.2〜1 秒かかり、全フレームを処理すると実時間に追いつかない。間引くと速い手を読み違える
// （実際の動画で、30fps 相当にしただけで崩れた）ので、動いている間は全フレームを処理し、止まっている間だけ飛ばす。
// 動き出したら、飛ばした直前の HOLD 枚も処理する（回し始めの時刻を決めるのに、動く直前のフレームが要る。ゆっくり回し始めると
// 最初の数フレームは差が小さく「止まっている」に入るので、直前の 1 枚だけでは回し始めを 45ms 遅く読んでいた: 4 個の配置の合成動画）。
// 止まっている間に KEEP_MS ごとに処理する 1 枚も、取っておいた中のいちばん古いものにする（新しい方は動き出したときのために残す）。
// 止まった最初の 1 枚も処理する（回し終わりの時刻のため）
import type { PixelSource } from "./image";

const GRID = 40; // 明るさを比べる点の数（縦横）
const STILL = 2.2; // 隣のフレームとの明るさの差の平均がこれ未満なら止まっている（0..255）
const KEEP_MS = 200; // 止まっていても、この間隔に 1 枚は処理する
const HOLD = 4; // 動き出したときに処理する、飛ばした直前のフレームの数

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
  private moving = true; // 直前のフレームで動いていたか
  private lastDone = -Infinity;
  private held: { img: PixelSource; t: number }[] = []; // 飛ばした直前のフレーム（古い順、HOLD 枚まで）
  skipped = 0;

  // このフレームで処理するもの（0〜HOLD + 1 枚。時刻順）
  next<T extends PixelSource>(img: T, t: number): { img: T; t: number }[] {
    const cur = thumb(img);
    let diff = Infinity;
    if (this.prev) {
      let s = 0;
      for (let i = 0; i < cur.length; i++) s += Math.abs(cur[i] - this.prev[i]);
      diff = s / cur.length;
    }
    this.prev = cur;
    const wasMoving = this.moving;
    this.moving = diff >= STILL;
    if (!this.moving && !wasMoving) {
      // 止まっている: 飛ばして HOLD 枚まで取っておく（古いものの画素の入れ物を使い回す）
      const old = this.held.length >= HOLD ? this.held.shift()! : null;
      this.held.push({ img: copy(img, old?.img), t });
      // KEEP_MS ごとに 1 枚は処理する。取っておいた中のいちばん古いもの（新しいものは、すぐ後に動き出したときのために残す）
      if (t - this.lastDone >= KEEP_MS) {
        const h = this.held.shift()!;
        this.lastDone = t;
        return [h as { img: T; t: number }];
      }
      this.skipped++;
      return [];
    }
    // 動いている・止まった最初の 1 枚（回し終わりの時刻を決めるのに、止まった直後のフレームが要る）: 取っておいたものと一緒に処理する
    const out = this.held.map((h) => h as { img: T; t: number });
    out.push({ img, t });
    this.held = [];
    this.lastDone = t;
    return out;
  }
}

// ImageData の幅・高さはプロトタイプのゲッターなので、展開せずに書き出す
function copy<T extends PixelSource>(img: T, reuse?: PixelSource): T {
  const data = reuse && reuse.data.length === img.data.length ? (reuse.data as Uint8ClampedArray) : new Uint8ClampedArray(img.data.length);
  data.set(img.data);
  return { data, width: img.width, height: img.height } as T;
}

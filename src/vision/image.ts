// 画像まわりの共通の部品: OpenCV.js の読み込み、画素の入れ物、明るさ（max(R, G, B)）。DOM もカメラも知らない
//
// OpenCV.js には使える型定義がない
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CV = any;

export interface PixelSource {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

// OpenCV.js モジュールの初期化（ビルドによって Promise / onRuntimeInitialized / 即時 のいずれか）
export async function initOpenCv(mod: CV): Promise<CV> {
  // 読み込めたモジュールが then を持っていると、async 関数から返すときにまた展開されて終わらない（Emscripten のモジュールは
  // 読み込み前は then を持つ: 自分でビルドした src/vendor/opencv/）。then を外して返す
  const ready = (m: CV): CV => {
    if (typeof m.then === "function") delete m.then;
    return m;
  };
  if (mod?.Mat) return ready(mod);
  if (typeof mod?.then === "function") {
    // then を持つオブジェクトをそのまま resolve すると再度展開されるので包んで受け取る
    const wrapped = await new Promise<{ m: CV }>((resolve) => mod.then((m: CV) => resolve({ m })));
    return wrapped.m?.Mat ? ready(wrapped.m) : initOpenCv(wrapped.m);
  }
  await new Promise<void>((resolve) => (mod.onRuntimeInitialized = () => resolve()));
  return mod;
}

// RGBA の画素から max(R, G, B)（HSV の V と同じ値）
export function maxRgb(src: Uint8ClampedArray | Uint8Array, dst: Uint8Array): void {
  if (src.byteOffset % 4 === 0) {
    // 1 画素を 1 回で読む（リトルエンディアン: R が下位のバイト）
    const px = new Uint32Array(src.buffer, src.byteOffset, dst.length);
    for (let j = 0; j < dst.length; j++) {
      const v = px[j];
      const r = v & 255;
      const g = (v >>> 8) & 255;
      const b = (v >>> 16) & 255;
      dst[j] = r > g ? (r > b ? r : b) : g > b ? g : b;
    }
    return;
  }
  for (let i = 0, j = 0; j < dst.length; i += 4, j++) {
    const r = src[i];
    const g = src[i + 1];
    const b = src[i + 2];
    dst[j] = r > g ? (r > b ? r : b) : g > b ? g : b;
  }
}

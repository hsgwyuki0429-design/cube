// 復号した録画のフレーム（VideoFrame）を、canvas を通さずに画素（RGBA）にする。精密解析の Worker で使う。
// iPhone の Safari では、映像のフレームを canvas に描いて getImageData で読むのを繰り返すと、canvas の側のメモリが溜まって
// タブごと落ちることがある（WebKit の報告: 259676・254974・256366・212214）。止めた後の残りの解析は 1 秒に何十枚もこれを繰り返す。
// VideoFrame.copyTo で YUV（I420・NV12）か RGB のまま取り出し、JS で RGBA に直す。対応しない形式なら null（呼び出し側は canvas で）
import type { PixelSource } from "./image";

export type PlaneFormat = "I420" | "NV12" | "RGBA" | "RGBX" | "BGRA" | "BGRX";
const FORMATS: readonly string[] = ["I420", "NV12", "RGBA", "RGBX", "BGRA", "BGRX"];

interface Plane {
  offset: number;
  stride: number;
}

// YUV → RGB の係数（Kr・Kb）。H.264 の色の表し方が分からなければ BT.709
function coefficients(matrix: string | null | undefined): { kr: number; kb: number } {
  if (matrix === "smpte170m" || matrix === "bt470bg") return { kr: 0.299, kb: 0.114 };
  return { kr: 0.2126, kb: 0.0722 };
}

// copyTo で取り出した画素（planes の並び）を RGBA にする。テストのために VideoFrame から切り離してある
export function planesToRgba(src: Uint8Array, planes: Plane[], format: PlaneFormat, width: number, height: number, matrix?: string | null, fullRange?: boolean | null): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  if (format === "RGBA" || format === "RGBX" || format === "BGRA" || format === "BGRX") {
    const { offset, stride } = planes[0];
    const bgr = format[0] === "B";
    for (let y = 0; y < height; y++) {
      let s = offset + y * stride;
      let o = y * width * 4;
      for (let x = 0; x < width; x++, s += 4, o += 4) {
        out[o] = src[s + (bgr ? 2 : 0)];
        out[o + 1] = src[s + 1];
        out[o + 2] = src[s + (bgr ? 0 : 2)];
        out[o + 3] = 255;
      }
    }
    return out;
  }
  const { kr, kb } = coefficients(matrix);
  const kg = 1 - kr - kb;
  // 限られた範囲（16〜235・16〜240）なら広げる
  const ys = fullRange ? 1 : 255 / 219;
  const y0 = fullRange ? 0 : 16;
  const cs = fullRange ? 1 : 255 / 224;
  const rv = 2 * (1 - kr) * cs;
  const bu = 2 * (1 - kb) * cs;
  const gu = ((2 * (1 - kb) * kb) / kg) * cs;
  const gv = ((2 * (1 - kr) * kr) / kg) * cs;
  const Y = planes[0];
  const nv12 = format === "NV12";
  const U = planes[1];
  const V = nv12 ? planes[1] : planes[2];
  for (let y = 0; y < height; y++) {
    const yRow = Y.offset + y * Y.stride;
    const cy = y >> 1;
    const uRow = U.offset + cy * U.stride;
    const vRow = V.offset + cy * V.stride;
    let o = y * width * 4;
    for (let x = 0; x < width; x++, o += 4) {
      const l = (src[yRow + x] - y0) * ys;
      const cx = x >> 1;
      const u = (nv12 ? src[uRow + cx * 2] : src[uRow + cx]) - 128;
      const v = (nv12 ? src[vRow + cx * 2 + 1] : src[vRow + cx]) - 128;
      out[o] = l + rv * v;
      out[o + 1] = l - gu * u - gv * v;
      out[o + 2] = l + bu * u;
      out[o + 3] = 255;
    }
  }
  return out;
}

// 取り出しに使う入れ物は使い回す（RGBA にした画素は解析が何枚か持っておくので、毎回新しく作る）
let scratch: Uint8Array | null = null;

export async function framePixels(frame: VideoFrame, width: number, height: number): Promise<PixelSource | null> {
  const format = frame.format;
  const rect = frame.visibleRect;
  if (!format || !FORMATS.includes(format) || !rect || rect.width !== width || rect.height !== height || typeof frame.copyTo !== "function") return null;
  try {
    const size = frame.allocationSize({ rect });
    if (!scratch || scratch.byteLength < size) scratch = new Uint8Array(size);
    const layout = await frame.copyTo(scratch, { rect });
    const cs = frame.colorSpace;
    return { data: planesToRgba(scratch, layout, format as PlaneFormat, width, height, cs?.matrix, cs?.fullRange), width, height };
  } catch {
    return null; // 取り出せない（ハードウェアのフレームなど）: canvas で
  }
}

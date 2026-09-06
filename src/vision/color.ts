/**
 * 色空間変換と色分類。
 *
 * 汎用の色分類器は作らない（CLAUDE.md「色認識仕様」）。
 * そのキューブのその照明下の6色を実測し、CIELab 上の最近傍で分類する。
 */

export type Lab = [number, number, number];

// --- sRGB -> 線形RGB -> XYZ -> CIELab (D65) ---------------------------------

const D65_X = 0.95047;
const D65_Y = 1.0;
const D65_Z = 1.08883;
const DELTA = 6 / 29;
const DELTA3 = DELTA * DELTA * DELTA;

export function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function labF(t: number): number {
  return t > DELTA3 ? Math.cbrt(t) : t / (3 * DELTA * DELTA) + 4 / 29;
}

/** sRGB (0..255) -> CIELab。 */
export function rgbToLab(r: number, g: number, b: number, out: Lab = [0, 0, 0]): Lab {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / D65_X;
  const Y = (0.2126729 * R + 0.7151522 * G + 0.072175 * B) / D65_Y;
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / D65_Z;
  const fx = labF(X);
  const fy = labF(Y);
  const fz = labF(Z);
  out[0] = 116 * fy - 16;
  out[1] = 500 * (fx - fy);
  out[2] = 200 * (fy - fz);
  return out;
}

/** 表示用の逆変換（分類色をオーバーレイに塗るのに使う）。 */
export function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const finv = (t: number) => (t > DELTA ? t * t * t : 3 * DELTA * DELTA * (t - 4 / 29));
  const X = finv(fx) * D65_X;
  const Y = finv(fy) * D65_Y;
  const Z = finv(fz) * D65_Z;
  const lin = [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ];
  return lin.map((v) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
  }) as [number, number, number];
}

/** CIE76 の色差（ユークリッド距離）。フェーズ0ではこれで足りる。 */
export function deltaE(a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number): number {
  const dl = a[ai] - b[bi];
  const da = a[ai + 1] - b[bi + 1];
  const db = a[ai + 2] - b[bi + 2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

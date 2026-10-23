// sRGB ⇄ CIELab (D65) と色差。
export type Lab = [number, number, number];
export type Rgb = [number, number, number];

const WHITE = [0.95047, 1.0, 1.08883];

// 0..255 の sRGB 値 → 線形値（表引き）
const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  LINEAR[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function f(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116;
}

export function rgbToLab(r8: number, g8: number, b8: number): Lab {
  const r = LINEAR[r8 | 0];
  const g = LINEAR[g8 | 0];
  const b = LINEAR[b8 | 0];
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / WHITE[0];
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / WHITE[2];
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToRgb([L, a, b]: Lab): Rgb {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
  const x = inv(fx) * WHITE[0];
  const y = inv(fy);
  const z = inv(fz) * WHITE[2];
  const lin = [
    3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.969266 * x + 1.8760108 * y + 0.041556 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ];
  return lin.map((v) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, c)) * 255);
  }) as Rgb;
}

export const rgbCss = ([r, g, b]: Rgb) => `rgb(${r},${g},${b})`;
export const labCss = (lab: Lab) => rgbCss(labToRgb(lab));

export function deltaE76(a: Lab, b: Lab): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// 明度の重みを半分にした ΔE76。照明ムラで明るさが変わっても色相・彩度で区別できる。
export function colorDistance(a: Lab, b: Lab): number {
  return Math.hypot((a[0] - b[0]) * 0.5, a[1] - b[1], a[2] - b[2]);
}

export function meanLab(samples: Lab[]): Lab {
  const s: Lab = [0, 0, 0];
  for (const x of samples) {
    s[0] += x[0];
    s[1] += x[1];
    s[2] += x[2];
  }
  const n = Math.max(1, samples.length);
  return [s[0] / n, s[1] / n, s[2] / n];
}

export function medianLab(samples: Lab[]): Lab {
  const med = (k: number) => {
    const v = samples.map((s) => s[k]).sort((p, q) => p - q);
    return v[Math.floor(v.length / 2)] ?? 0;
  };
  return [med(0), med(1), med(2)];
}

// 標準的なステッカー色（名前付けと、キャリブレーション前の大まかな分類にだけ使う）
export const NAMED_COLORS = [
  { id: "W", name: "白", lab: [92, 0, 2] as Lab, display: "#f4f4f4" },
  { id: "Y", name: "黄", lab: [86, -4, 78] as Lab, display: "#ffd500" },
  { id: "R", name: "赤", lab: [44, 62, 38] as Lab, display: "#d0213a" },
  { id: "O", name: "橙", lab: [64, 46, 68] as Lab, display: "#ff6a00" },
  { id: "B", name: "青", lab: [38, 12, -58] as Lab, display: "#1157d6" },
  { id: "G", name: "緑", lab: [58, -58, 34] as Lab, display: "#00a651" },
] as const;
export type NamedColorId = (typeof NAMED_COLORS)[number]["id"];

export function nearestNamed(lab: Lab): number {
  let best = 0;
  let bestD = Infinity;
  NAMED_COLORS.forEach((c, i) => {
    const d = colorDistance(lab, c.lab);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

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

// ---------------------------------------------------------------------------
// カラープロファイル（そのキューブのその照明下の6色）
// ---------------------------------------------------------------------------

export interface ColorProfile {
  id: string;
  name: string;
  /** 6色 × Lab = 18。添字は FaceIndex（U,R,F,D,L,B の初期面 = 色ID）。 */
  refLab: number[];
  /** キャリブレーション時の各面のばらつき（代表ベクトルからの平均距離）。 */
  spread: number[];
  createdAt: number;
}

/** 6色間の最小距離がこれを下回ると判別が苦しい（CIE76 ΔE）。実測して調整する前提の初期値。 */
export const MIN_SEPARATION_WARN = 22;
export const MIN_SEPARATION_FAIL = 12;

export interface Classification {
  /** 0..5。ref が空なら -1 */
  label: number;
  /** 1 - (最近傍距離 / 次点距離)。0..1 */
  conf: number;
  d1: number;
  d2: number;
}

/** 6つの代表ベクトルへの最近傍。 */
export function classifyLab(
  lab: ArrayLike<number>,
  off: number,
  ref: ArrayLike<number>,
): Classification {
  let best = -1;
  let d1 = Infinity;
  let d2 = Infinity;
  for (let f = 0; f < 6; f++) {
    const d = deltaE(lab, off, ref, f * 3);
    if (d < d1) {
      d2 = d1;
      d1 = d;
      best = f;
    } else if (d < d2) {
      d2 = d;
    }
  }
  // 次点が 0 距離（= 代表ベクトルが重複）なら信頼度は 0
  const conf = d2 > 0 && Number.isFinite(d2) ? Math.max(0, 1 - d1 / d2) : 0;
  return { label: best, conf, d1, d2 };
}

/** 9セルまとめて分類。 */
export function classifyCells(
  lab: Float32Array,
  ref: ArrayLike<number>,
  labels: Int8Array,
  conf: Float32Array,
): void {
  for (let i = 0; i < 9; i++) {
    const c = classifyLab(lab, i * 3, ref);
    labels[i] = c.label;
    conf[i] = c.conf;
  }
}

/** 6色間の最小距離とその組。判別困難な配色の警告に使う。 */
export function refMinDistance(ref: ArrayLike<number>): { d: number; a: number; b: number } {
  let d = Infinity;
  let a = -1;
  let b = -1;
  for (let i = 0; i < 6; i++) {
    for (let j = i + 1; j < 6; j++) {
      const dd = deltaE(ref, i * 3, ref, j * 3);
      if (dd < d) {
        d = dd;
        a = i;
        b = j;
      }
    }
  }
  return { d, a, b };
}

/**
 * 高信頼セルで代表ベクトルを EMA 更新する（オンライン適応）。
 * 照明がゆっくり変わるケースを吸収するのが目的。速く動かすと壊れるので alpha は小さく。
 * @returns 更新に使われたセル数
 */
export function adaptRef(
  ref: Float32Array,
  lab: Float32Array,
  labels: ArrayLike<number>,
  conf: ArrayLike<number>,
  minConf: number,
  alpha: number,
): number {
  let used = 0;
  for (let i = 0; i < 9; i++) {
    const l = labels[i];
    if (l < 0 || conf[i] < minConf) continue;
    const o = l * 3;
    ref[o] += alpha * (lab[i * 3] - ref[o]);
    ref[o + 1] += alpha * (lab[i * 3 + 1] - ref[o + 1]);
    ref[o + 2] += alpha * (lab[i * 3 + 2] - ref[o + 2]);
    used++;
  }
  return used;
}

/**
 * キャリブレーション中の1面ぶんの蓄積。
 * 完成キューブの1面は9セルすべて同色なので、9セル×複数フレームを全部平均する。
 */
export class FaceAccumulator {
  private sum: [number, number, number] = [0, 0, 0];
  private samples: Lab[] = [];

  add(lab: Float32Array): void {
    for (let i = 0; i < 9; i++) {
      const v: Lab = [lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]];
      this.samples.push(v);
      this.sum[0] += v[0];
      this.sum[1] += v[1];
      this.sum[2] += v[2];
    }
  }

  get count(): number {
    return this.samples.length;
  }

  /** 平均 Lab と、平均からの平均距離（ばらつき）。 */
  result(): { lab: Lab; spread: number } {
    const n = this.samples.length || 1;
    const mean: Lab = [this.sum[0] / n, this.sum[1] / n, this.sum[2] / n];
    let s = 0;
    for (const v of this.samples) s += Math.hypot(v[0] - mean[0], v[1] - mean[1], v[2] - mean[2]);
    return { lab: mean, spread: s / n };
  }

  reset(): void {
    this.sum = [0, 0, 0];
    this.samples.length = 0;
  }
}

// ---------------------------------------------------------------------------
// プロファイル永続化（複数キューブを登録・切替）
// ---------------------------------------------------------------------------

const PROFILE_KEY = 'cubevision.profiles.v1';
const ACTIVE_KEY = 'cubevision.activeProfile.v1';

export function loadProfiles(): ColorProfile[] {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    return raw ? (JSON.parse(raw) as ColorProfile[]) : [];
  } catch {
    return [];
  }
}

export function saveProfiles(list: ColorProfile[]): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(list));
  } catch { /* noop */ }
}

export function getActiveProfileId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function setActiveProfileId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch { /* noop */ }
}

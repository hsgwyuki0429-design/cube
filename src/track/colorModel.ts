// キャリブレーション済みの6色（Lab）への最近傍分類と、デコーダに渡すソフトなコスト。
import { type Lab, colorDistance } from "../vision/color";

export interface ColorModelOptions {
  maxDistance: number; // どの色からもこれ以上遠ければ「不明」（手・背景・反射）
  tau: number; // 最近傍との距離差がこれだけあれば矛盾コスト満額
  mismatchCost: number; // 1枚の矛盾のコスト（1手のコスト 1.0 との比較）
  adaptRate: number; // 高信頼の観測で代表色を寄せる割合（照明変化への追従）
}

export const DEFAULT_COLOR_MODEL: ColorModelOptions = {
  maxDistance: 32,
  tau: 12,
  mismatchCost: 1.5,
  adaptRate: 0.03,
};

export interface Classified {
  label: number; // -1 = 不明
  distance: number;
  confidence: number; // (2位 - 1位) / (2位 + 1位)
}

// 肌（指・手）らしい色: 暖色で色味が弱い（彩度 12〜35、色相 10〜75°）。キューブの色は、白は彩度が 8 未満、赤・橙・黄は
// 50 以上なので、この範囲にはふつう入らない。肌は白から ΔE 25 程度しか離れておらず、手の検出が外れると白に読まれていた
export function skinLike(lab: Lab): boolean {
  const c = Math.hypot(lab[1], lab[2]);
  if (c < 12 || c > 35) return false;
  const hue = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
  return hue > 10 && hue < 75;
}
const SKIN_MARGIN = 12; // 代表色のどれかにここまで近ければ（肌に近い色のキューブ）肌とみなさない

export class ColorModel {
  refs: Lab[];
  readonly initial: Lab[];
  options: ColorModelOptions;

  constructor(refs: Lab[], options: Partial<ColorModelOptions> = {}) {
    this.refs = refs.map((r) => [...r] as Lab);
    this.initial = refs.map((r) => [...r] as Lab);
    this.options = { ...DEFAULT_COLOR_MODEL, ...options };
  }

  distances(lab: Lab): number[] {
    return this.refs.map((r) => colorDistance(lab, r));
  }

  classify(lab: Lab): Classified {
    const d = this.distances(lab);
    let best = 0;
    for (let i = 1; i < 6; i++) if (d[i] < d[best]) best = i;
    let second = Infinity;
    for (let i = 0; i < 6; i++) if (i !== best && d[i] < second) second = d[i];
    const confidence = (second - d[best]) / (second + d[best] || 1);
    const unknown = d[best] > this.options.maxDistance || (d[best] > SKIN_MARGIN && skinLike(lab));
    return { label: unknown ? -1 : best, distance: d[best], confidence };
  }

  // out[c] = このセルが色 c だと仮定したときのペナルティ。不明なら全部 0
  costs(lab: Lab, out: Float32Array, offset: number): number {
    const d = this.distances(lab);
    const min = Math.min(...d);
    const { maxDistance, tau, mismatchCost } = this.options;
    if (min > maxDistance || (min > SKIN_MARGIN && skinLike(lab))) {
      for (let c = 0; c < 6; c++) out[offset + c] = 0;
      return -1;
    }
    let label = 0;
    for (let c = 0; c < 6; c++) {
      out[offset + c] = mismatchCost * Math.min(1, Math.max(0, (d[c] - min) / tau));
      if (d[c] === min) label = c;
    }
    return label;
  }

  // 正解だと分かっている色で代表色をゆっくり更新する（デコーダが確信した観測のみ）
  adapt(lab: Lab, color: number): void {
    const r = this.refs[color];
    const d = colorDistance(lab, r);
    if (d > this.options.maxDistance * 0.6) return;
    // 初期値から離れすぎないように
    if (colorDistance(lab, this.initial[color]) > this.options.maxDistance) return;
    const a = this.options.adaptRate;
    for (let k = 0; k < 3; k++) r[k] = r[k] * (1 - a) + lab[k] * a;
  }

  // 6色間の最小距離（判別しにくい配色の警告用）
  minSeparation(): { distance: number; pair: [number, number] } {
    let best = { distance: Infinity, pair: [0, 1] as [number, number] };
    for (let i = 0; i < 6; i++)
      for (let j = i + 1; j < 6; j++) {
        const d = colorDistance(this.refs[i], this.refs[j]);
        if (d < best.distance) best = { distance: d, pair: [i, j] };
      }
    return best;
  }
}

// キャリブレーション前でも使える「ステッカーらしさ」。黒いプラスチックや隙間は −、鮮やかな色や白は +。
import type { Lab } from "./color";

export function stickerScore([L, a, b]: Lab): number {
  if (L < 22) return -1;
  const chroma = Math.hypot(a, b);
  if (chroma > 28 || L > 72) return 0.6;
  return -0.2;
}

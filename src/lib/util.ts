// どこからでも使う小さな関数（DOM にもカメラにも依存しない）

// 例外を画面・メッセージに出す文字列にする
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// 中央値（偶数個なら真ん中の 2 つの平均。空なら NaN）
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}

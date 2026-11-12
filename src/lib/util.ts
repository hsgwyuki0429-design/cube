// どこからでも使う小さな関数（DOM にもカメラにも依存しない）

// 例外を画面・メッセージに出す文字列にする
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// 中央値（偶数個なら真ん中の 2 つの平均。空なら NaN）
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}

// 3 次元の内積
export const dot3 = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// 色味: 最大のチャンネルで割る（明暗によらない）
export const chroma = (rgb: readonly number[]): [number, number, number] => {
  const m = Math.max(rgb[0], rgb[1], rgb[2], 1);
  return [rgb[0] / m, rgb[1] / m, rgb[2] / m];
};

// 文字列をファイルとして保存させる（ブラウザだけ）
export function downloadText(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

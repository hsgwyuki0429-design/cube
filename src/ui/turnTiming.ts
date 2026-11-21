// 3D で 1 手を回す長さ（DOM も three.js も知らない: ライブの見せ方の試験 tests/liveShow.test.ts・tests/debug で同じ長さを使う）

// 回す速さ: 1/4 回転・半回転の長さ（ms）。待っている手があれば速める（下限あり）
export const TURN_MS = 190;
export const HALF_MS = 270;
export const MIN_TURN_MS = 85;

// amount: 1・3 = 1/4 回転、2 = 半回転。queued: 後ろで待っている（回して見せる）手の数
export function turnMs(amount: number, queued: number): number {
  const base = amount === 2 ? HALF_MS : TURN_MS;
  const speed = 1 + 0.45 * queued; // 溜まっていれば速める
  return Math.max(amount === 2 ? MIN_TURN_MS * 1.3 : MIN_TURN_MS, base / speed);
}

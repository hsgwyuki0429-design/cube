// キューブの状態（54 枚の色）のハッシュ（衝突確率は無視できる）

// 2 つの 32bit のハッシュ
export function hashState(s: Uint8Array): [number, number] {
  let h1 = 0x811c9dc5;
  let h2 = 0x1b873593;
  for (let i = 0; i < 54; i++) {
    h1 = Math.imul(h1 ^ s[i], 0x01000193);
    h2 = Math.imul(h2 ^ (s[i] + i * 7), 0x5bd1e995);
    h2 ^= h2 >>> 13;
  }
  return [h1 >>> 0, h2 >>> 0];
}

// 53bit のハッシュ（1 つの数）
export function hash53(s: Uint8Array): number {
  const [h1, h2] = hashState(s);
  return h1 * 0x200000 + (h2 & 0x1fffff);
}

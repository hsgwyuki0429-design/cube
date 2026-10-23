// 54 枚のステッカーに、各色ちょうど 9 枚になるよう色を割り当てる（ハンガリアン法）。
// 赤／橙のような紛らわしい1枚も、残り 53 枚の制約で正しく直る。
//
// hungarian() は AllefDouglasDev/rubik-cube (MIT) の app/src/vision/assign.ts と同じ標準的な実装。

// 正方コスト行列の最小コスト完全マッチング。各行に割り当てた列を返す。
export function hungarian(cost: number[][]): number[] {
  const n = cost.length;
  const INF = Number.POSITIVE_INFINITY;
  const u = new Array(n + 1).fill(0);
  const v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0);
  const way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(INF);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const result = new Array(n).fill(-1);
  for (let j = 1; j <= n; j++) if (p[j]) result[p[j] - 1] = j - 1;
  return result;
}

// samples の各要素に 0..k-1 の色を、各色 samples.length / k 枚ずつ割り当てる
export function assignBalanced(dist: number[][]): number[] {
  const n = dist.length;
  const k = dist[0].length;
  const per = n / k;
  if (!Number.isInteger(per)) throw new Error("サンプル数が色数で割り切れません");
  const cost = dist.map((row) => row.flatMap((d) => new Array(per).fill(d)));
  return hungarian(cost).map((col) => Math.floor(col / per));
}

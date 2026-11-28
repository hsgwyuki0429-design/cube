// 配置ごと（ステッカーのマーカーの配置: 4 個 quad-half / 1 個 standard）の表。realVideo の REAL_STATS_OUT の行（1 本 1 行）を配置ごとにまとめる。
// recordingStats.debug.test.ts の「配置ごと」と scripts/real-table.mjs の --group stickers が同じものを使う（同じ物差し）。
// Node が型を消すだけで .mjs からも読めるように、型以外は import しない
export interface LayoutRow {
  layout?: string; // ないのは配置を残す前の書き出しで quad-half
  cells: number; // 精密に処理した 1 フレームに ID が読めたマス（平均）
  pieces: number;
  gaps1Sec: number; // 確かな読みのない 1 秒より長い区間の合計（秒）
  solved: boolean;
  inferred: number;
  faceless?: number; // 面が組めなかったフレームの割合
  masked?: number; // 組めた面のマスのうち指で隠れた割合
  misread?: number; // 誤読（精密解析の答えを正解の代わりにして照らした、合わない読みの割合）
  misreadReads?: number;
  waitMs?: number; // 止めた後の待ち（本体）
  app?: { solved: boolean; inferred: number; moves: number } | null; // 本体の結果（あればこちらで数える）
}

export const layoutOf = (r: { layout?: string }) => r.layout ?? "quad-half";
export const LAYOUT_LABEL: Record<string, string> = { "quad-half": "4 個", standard: "1 個" };

const fin = (xs: (number | undefined)[]) => xs.filter((x): x is number => x !== undefined && Number.isFinite(x));
export const meanOf = (xs: (number | undefined)[]) => {
  const v = fin(xs);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : Number.NaN;
};
export const medianOf = (xs: (number | undefined)[]) => {
  const v = fin(xs).sort((a, b) => a - b);
  if (!v.length) return Number.NaN;
  const h = v.length >> 1;
  return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2;
};

// 配置ごとに「平均」と「中央」の 2 行（誤読の平均は読みの数で重みをつけた全体の割合・中央は 1 本ごとの割合の中央。待ちは平均・最大と中央）
export function layoutTable(rows: LayoutRow[]): string[] {
  const out: string[] = [];
  out.push("| 配置 | 集め方 | 本数 | 1 フレームに読めたマス | ピース | 誤読 | 面が組めない | 指で隠れた | 確かな読みのない 1 秒より長い区間 | 完成 | 推定（1 本あたり） | 止めた後の待ち |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  const pc = (x: number, d = 1) => (Number.isNaN(x) ? "-" : `${(x * 100).toFixed(d)}%`);
  const n2 = (x: number) => (Number.isNaN(x) ? "-" : x.toFixed(2));
  for (const lay of [...new Set(rows.map(layoutOf))]) {
    const g = rows.filter((r) => layoutOf(r) === lay);
    const solved = g.filter((r) => (r.app ? r.app.solved : r.solved)).length;
    const inferred = g.map((r) => (r.app ? r.app.inferred : r.inferred));
    const waits = fin(g.map((r) => r.waitMs));
    const reads = g.reduce((n, r) => n + (r.misreadReads ?? 0), 0);
    const misAll = reads ? g.reduce((n, r) => n + (r.misread ?? 0) * (r.misreadReads ?? 0), 0) / reads : Number.NaN;
    const name = `${lay}（${LAYOUT_LABEL[lay] ?? lay}）`;
    for (const [how, f] of [
      ["平均", meanOf],
      ["中央", medianOf],
    ] as const) {
      const mis = how === "平均" ? (Number.isNaN(misAll) ? "-" : `${pc(misAll, 2)}（${reads}）`) : pc(medianOf(g.map((r) => (r.misreadReads ? r.misread : undefined))), 2);
      const wait = !waits.length ? "-" : how === "平均" ? `${(meanOf(waits) / 1000).toFixed(1)}・最大 ${(Math.max(...waits) / 1000).toFixed(1)} 秒` : `${(medianOf(waits) / 1000).toFixed(1)} 秒`;
      out.push(`| ${name} | ${how} | ${g.length} | ${n2(f(g.map((r) => r.cells)))} | ${n2(f(g.map((r) => r.pieces)))} | ${mis} | ${pc(f(g.map((r) => r.faceless)))} | ${pc(f(g.map((r) => r.masked)))} | ${f(g.map((r) => r.gaps1Sec)).toFixed(1)} 秒 | ${solved}/${g.length} | ${f(inferred).toFixed(1)} | ${wait} |`);
    }
  }
  return out;
}

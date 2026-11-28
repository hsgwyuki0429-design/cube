// 読める量の物差しのまとめ: realVideo.debug.test.ts の REAL_STATS_OUT（1 本 1 行）を条件（REAL_STATS_LABEL）ごとに並べる。
// 実機の録画（設定画面の「録画を書き出す」）と、同じ物差しで測った x264 の 5・2.5Mbps（bench-2 の圧縮）を比べる。
//   RS_ROWS=rows.jsonl npx vitest run -c vitest.debug.config.ts tests/debug/recordingStats.debug.test.ts --silent=false
// 物差し（範囲はソルブの間: 精密解析の最初の手の回し始め〜最後の手の回し終わり）:
//   fps = 範囲の中の録画のフレーム ÷ 長さ・抜け = 間隔が中央の 1.5 倍より長い所（失ったとみられる枚数）・間引き = 録画の圧縮が追いつかずに
//   間引いたフレーム（実機の書き出しだけ。録画全体）・マス / ピース = 精密に処理した 1 フレームに ID が読めた数の平均・
//   確かな読みのない区間 = 確かな読み（src/track/pieces/solve.ts の strongOf と同じ）のある見え方のない間（1 秒より長いものの数と合計、いちばん長いもの）。
//   「決まった面だけ」はセンター 1 つの面の読みを数えないもの
// 配置ごと（ステッカーのマーカーの配置: 書き出しの stickers。?stickers=standard で撮ったもの）の表も出す: 1 フレームに読めたマス・誤読
//   （精密解析の答えを正解の代わりにして照らした、合わない読みの割合: lib/recording.ts の misreadOf）・面が組めなかったフレームの割合・
//   指で隠れたマスの割合・精密解析の完成と推定（本体の結果。書き出しになければこの解析の結果）・止めた後の待ち（本体。書き出しの waitMs）
import { readFileSync } from "node:fs";
import { it } from "vitest";

interface Row {
  name: string;
  label: string;
  seconds: number;
  fps: number;
  medianMs: number;
  holes: number;
  missing: number;
  refined: number;
  cells: number;
  pieces: number;
  gaps05: number;
  gaps1: number;
  gaps1Sec: number;
  longest: number;
  gapSec: number;
  sure1Sec?: number;
  sureLongest?: number;
  solved: boolean;
  inferred: number;
  recorder?: { frames: number; dropped: number; codec: string; hw: string | null; bitrate: number };
  layout?: string; // ステッカーのマーカーの配置（2026-11-28 から）
  faceless?: number;
  masked?: number;
  misread?: number;
  misreadReads?: number;
  waitMs?: number;
  app?: { solved: boolean; inferred: number; moves: number } | null;
}

it("読める量のまとめ", () => {
  const file = process.env.RS_ROWS;
  if (!file) return;
  const rows = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row);
  const out: string[] = [];
  out.push("| 動画 | 条件 | ソルブ | fps | 抜け（か所・枚） | 間引き | 1 フレームに読めたマス | ピース | 確かな読みのない 1 秒より長い区間（合計） | いちばん長い | 完成 | 推定 |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const drop = r.recorder ? `${r.recorder.dropped}/${r.recorder.frames + r.recorder.dropped}` : "-";
    out.push(`| ${r.name} | ${r.label} | ${r.seconds.toFixed(1)} 秒 | ${r.fps} | ${r.holes}・${r.missing} | ${drop} | ${r.cells.toFixed(2)} | ${r.pieces.toFixed(2)} | ${r.gaps1}（${r.gaps1Sec.toFixed(1)} 秒） | ${r.longest.toFixed(2)} 秒 | ${r.solved ? "○" : "×"} | ${r.inferred} |`);
  }
  out.push("");
  out.push("| 条件 | 本数 | fps | 1 フレームに読めたマス | ピース | 確かな読みのない 1 秒より長い区間（1 本あたりの合計） | いちばん長い（平均） | 決まった面だけで数えた 1 秒より長い区間 | 完成 |");
  out.push("|---|---|---|---|---|---|---|---|---|");
  const labels = [...new Set(rows.map((r) => r.label))];
  for (const l of labels) {
    const g = rows.filter((r) => r.label === l);
    const avg = (f: (r: Row) => number) => g.reduce((n, r) => n + f(r), 0) / g.length;
    out.push(`| ${l} | ${g.length} | ${avg((r) => r.fps).toFixed(1)} | ${avg((r) => r.cells).toFixed(2)} | ${avg((r) => r.pieces).toFixed(2)} | ${avg((r) => r.gaps1Sec).toFixed(1)} 秒 | ${avg((r) => r.longest).toFixed(2)} 秒 | ${avg((r) => r.sure1Sec ?? Number.NaN).toFixed(1)} 秒 | ${g.filter((r) => r.solved).length}/${g.length} |`);
  }
  // 配置ごと
  out.push("");
  out.push("| 配置 | 本数 | 1 フレームに読めたマス | ピース | 誤読 | 面が組めない | 指で隠れた | 確かな読みのない 1 秒より長い区間 | 完成 | 推定（1 本あたり） | 止めた後の待ち（平均・最大） |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|");
  const pc = (x: number) => `${(x * 100).toFixed(1)}%`;
  for (const lay of [...new Set(rows.map((r) => r.layout ?? "quad-half"))]) {
    const g = rows.filter((r) => (r.layout ?? "quad-half") === lay);
    const avg = (f: (r: Row) => number | undefined) => {
      const xs = g.map(f).filter((x): x is number => x !== undefined && Number.isFinite(x));
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN;
    };
    const reads = g.reduce((n, r) => n + (r.misreadReads ?? 0), 0);
    const mis = reads ? g.reduce((n, r) => n + (r.misread ?? 0) * (r.misreadReads ?? 0), 0) / reads : Number.NaN;
    const solved = g.filter((r) => (r.app ? r.app.solved : r.solved)).length;
    const waits = g.map((r) => r.waitMs).filter((x): x is number => x !== undefined);
    out.push(`| ${lay} | ${g.length} | ${avg((r) => r.cells).toFixed(2)} | ${avg((r) => r.pieces).toFixed(2)} | ${Number.isNaN(mis) ? "-" : `${(mis * 100).toFixed(2)}%（${reads}）`} | ${pc(avg((r) => r.faceless))} | ${pc(avg((r) => r.masked))} | ${avg((r) => r.gaps1Sec).toFixed(1)} 秒 | ${solved}/${g.length} | ${avg((r) => (r.app ? r.app.inferred : r.inferred)).toFixed(1)} | ${waits.length ? `${(waits.reduce((a, b) => a + b, 0) / waits.length / 1000).toFixed(1)}・${(Math.max(...waits) / 1000).toFixed(1)} 秒` : "-"} |`);
  }
  console.log(out.join("\n"));
});

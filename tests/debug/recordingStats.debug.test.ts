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
//   指で隠れたマスの割合・精密解析の完成と推定（本体の結果。書き出しになければこの解析の結果）・止めた後の待ち（本体。書き出しの waitMs）。
//   配置ごとに平均と中央の 2 行（tests/debug/lib/layoutTable.ts。scripts/real-table.mjs の --group stickers も同じ）
//   RS_FILES=フォルダかファイル（, 区切り）: 書き出し（開発用の「書き出す」でまとめたファイル・「録画を書き出す」の録画）をそのまま読む
//   （1 本ずつ realVideo を REAL_STATS_OUT 付きで通してから並べる。RS_LABEL=条件の名前、既定は「実機」）
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { loadExport } from "./lib/recording";
import { layoutTable } from "./lib/layoutTable";

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
  let file = process.env.RS_ROWS;
  if (!file && process.env.RS_FILES) {
    const list = process.env.RS_FILES.split(",").flatMap((f) => (statSync(f).isDirectory() ? readdirSync(f).filter((n) => /\.(mp4|mov)$/i.test(n)).sort().map((n) => join(f, n)) : [f]));
    file = join(mkdtempSync(join(tmpdir(), "rs-")), "rows.jsonl");
    for (const v of list) {
      if (!loadExport(v)) {
        console.log(`書き出しではない（飛ばす）: ${v}`);
        continue;
      }
      const r = spawnSync("npx", ["vitest", "run", "-c", "vitest.debug.config.ts", "tests/debug/realVideo.debug.test.ts", "--silent=false"], { env: { ...process.env, REAL_VIDEO: v, REAL_STATS_OUT: file, REAL_STATS_LABEL: process.env.RS_LABEL ?? "実機", REAL_NAME: v.split("/").pop() }, encoding: "utf8", maxBuffer: 1 << 28 });
      if (r.status !== 0) console.log(`realVideo が失敗: ${v}\n${(r.stdout + r.stderr).slice(-2000)}`);
    }
  }
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
  // 配置ごと（平均と中央。scripts/real-table.mjs の --group stickers と同じ: lib/layoutTable.ts）
  out.push("");
  out.push(...layoutTable(rows));
  console.log(out.join("\n"));
}, 3600000);

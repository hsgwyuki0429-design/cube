// 実機の書き出しをまとめて通し、ソルブごとに 1 行の表を出す。フォルダの中の
//   - 開発用の「書き出す」でまとめたファイル（cubevision-日時-タイム.mp4: 録画・ライブの記録・要約が 1 つ）
//   - 今までの組（「録画を書き出す」の cubevision-rec-….mp4 と「ライブの記録を書き出す」の cubevision-live-….json.gz。同じソルブの組を
//     タイマーの開始の時刻・記録の番号で探す。片方だけでもよい）
// を全部読み、要約の項目（src/app/solveSummary.ts。今までの組は手元で同じ物差しで作る）と、手元で通した結果（realVideo で精密解析し直して
// 「アプリの結果と同じ」か、liveLog で通し直したライブの「実機と同じ」と 3D の一致）を並べる。GitHub のリリースに置いた実機の材料を毎回これで通す。
//
//   node scripts/real-table.mjs フォルダ [--no-refine] [--no-live] [--group stickers] [--json 行.jsonl] [--md 表.md]
//     --no-refine: realVideo を通さない（精密解析は 1 本数十秒〜数分）・--no-live: liveLog を通さない
//     --group stickers: 配置（4 個 quad-half / 1 個 standard。記録の Solve.stickers・書き出しの stickers）ごとに、この表の列の中央の行と、
//       recordingStats の「配置ごと」と同じ表（tests/debug/lib/layoutTable.ts: realVideo の読める量の物差し。平均と中央）を足す
// 配置の列は書き出しの配置（要約の stickers、なければ書き出しの stickers・精密解析の設定の arucoDesign、なければ quad-half）
// 手元の道具は vitest で動かす（npx vitest run -c vitest.debug.config.ts …）。ffmpeg・ffprobe が要る
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { LIVE_LOG_UUID, readRecordingMeta, readUuidBox } from "../src/vision/mp4Mux.ts";
import { summarizeSolve } from "../src/app/solveSummary.ts";
import { LAYOUT_LABEL, layoutTable, medianOf } from "../tests/debug/lib/layoutTable.ts";

const args = process.argv.slice(2);
const dir = args.find((a, i) => !a.startsWith("--") && !["--json", "--md", "--group"].includes(args[i - 1]));
const opt = (k) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!dir || !existsSync(dir)) {
  console.error("使い方: node scripts/real-table.mjs フォルダ [--no-refine] [--no-live] [--json 行.jsonl] [--md 表.md]");
  process.exit(1);
}
const noRefine = args.includes("--no-refine");
const noLive = args.includes("--no-live");
const group = opt("--group");
if (group && group !== "stickers") {
  console.error(`--group は stickers だけ: ${group}`);
  process.exit(1);
}
// 書き出しの配置（lib/recording.ts の exportLayout と同じ決め方）
const layoutOfMeta = (meta) => meta.summary?.stickers ?? meta.solve?.stickers ?? meta.stickers ?? meta.analysis?.input?.pipeline?.arucoDesign ?? "quad-half";

const gunz = (b) => (b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : Buffer.from(b));
const files = readdirSync(dir).sort().map((n) => join(dir, n));

// 録画（まとめたファイルを含む）とライブの記録を読む
const recs = [];
const lives = [];
for (const f of files) {
  if (/\.(mp4|mov)$/i.test(f)) {
    const buf = new Uint8Array(readFileSync(f));
    const meta = readRecordingMeta(buf);
    if (!meta || meta.kind !== "cubevision-recording") continue;
    const box = readUuidBox(buf, LIVE_LOG_UUID);
    recs.push({ file: f, meta, live: box ? JSON.parse(gunz(box).toString("utf8")) : null });
  } else if (/\.json(\.gz)?$/i.test(f)) {
    try {
      const data = JSON.parse(gunz(readFileSync(f)).toString("utf8"));
      if (data.kind === "cubevision-live-log") lives.push({ file: f, data, used: false });
    } catch {
      // 読めないファイルは飛ばす
    }
  }
}

const readingsOf = (live) => (live?.log?.segments ?? []).flatMap((s) => s.readings);
// 今までの組: 同じソルブのライブの記録（記録の番号・タイマーの開始の時刻・読みの範囲）
function pairLive(meta) {
  const id = meta.analysis?.live?.solveId;
  const startT = meta.analysis?.live?.startT;
  const by = (f) => lives.find((l) => !l.used && f(l.data));
  const hit =
    by((d) => id && (d.pair?.solveId === id || d.analysis?.solveId === id)) ??
    by((d) => startT !== undefined && d.timer?.startT === startT) ??
    by((d) => {
      const rs = readingsOf(d);
      return startT !== undefined && rs.length && rs[0].t <= startT && rs[rs.length - 1].t >= (meta.analysis?.live?.endT ?? startT);
    });
  if (hit) hit.used = true;
  return hit ?? null;
}

const recTimesMs = (file, meta) =>
  spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts", "-of", "csv=p=0", file], { encoding: "utf8", maxBuffer: 1 << 26 })
    .stdout.trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => (meta.timeOriginUs + Number.parseInt(l, 10)) / 1000);

const tmp = mkdtempSync(join(tmpdir(), "real-table-"));
function vitest(test, env) {
  return new Promise((resolve) => {
    const p = spawn("npx", ["vitest", "run", "-c", "vitest.debug.config.ts", test, "--silent=false"], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    p.stdout.on("data", (d) => (text += d));
    p.stderr.on("data", (d) => (text += d));
    p.on("close", (code) => resolve({ code, text }));
  });
}
const lastRow = (file) => {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
};

const rows = [];
let k = 0;
const items = recs.map((r) => ({ ...r, pair: r.live ? null : pairLive(r.meta) }));
for (const it of items) {
  k++;
  const { meta } = it;
  const live = it.live ?? it.pair?.data ?? null;
  const a = meta.analysis ?? {};
  const solve = meta.solve ?? {};
  const summary =
    meta.summary ??
    summarizeSolve({
      solveId: a.live?.solveId,
      timeMs: solve.timeMs,
      stickers: layoutOfMeta(meta),
      analysis: solve.analysis,
      waitMs: a.waitMs,
      result: a.result,
      error: a.error,
      retried: a.retried,
      startT: a.live?.startT,
      endT: a.live?.endT,
      framePath: meta.framePath ?? live?.framePath,
      rests: meta.rests ?? live?.rests ?? [],
      perf: meta.perf ?? live?.perf ?? [],
      readings: readingsOf(live),
      recTimesMs: recTimesMs(it.file, meta),
      recorder: meta.recorder,
    });
  const row = { file: it.file.split("/").pop(), live: it.live ? "まとめた" : it.pair ? it.pair.file.split("/").pop() : null, date: solve.date ?? null, layout: layoutOfMeta(meta), summary };
  console.error(`[${k}/${items.length}] ${row.file}${row.live && !it.live ? ` + ${row.live}` : ""}`);
  if (!noRefine) {
    const out = join(tmp, `refine-${k}.jsonl`);
    const statOut = join(tmp, `stats-${k}.jsonl`);
    const r = await vitest("tests/debug/realVideo.debug.test.ts", { REAL_VIDEO: it.file, REAL_OUT: out, REAL_STATS_OUT: statOut, REAL_STATS_LABEL: "実機", REAL_NAME: row.file });
    const got = lastRow(out).pop();
    // 読める量の物差し（recordingStats と同じ行: 精密に処理した 1 フレームに読めたマス・ピース・誤読・面が組めない・指・確かな読みのない区間）
    row.stats = lastRow(statOut).pop() ?? null;
    row.refine = got ? { sameAsApp: got.sameAsApp, solved: got.solved, inferred: got.inferred, moves: got.moves, diff: got.diff?.slice(0, 3) } : { error: `終了コード ${r.code}` };
  }
  if (!noLive && live) {
    const out = join(tmp, `live-${k}.jsonl`);
    const env = it.live ? { LIVE_LOG: it.file, LIVE_LOG_OUT: out } : { LIVE_LOG: it.pair.file, LIVE_LOG_REC: it.file, LIVE_LOG_OUT: out };
    const r = await vitest("tests/debug/liveLog.debug.test.ts", env);
    const segs = lastRow(out);
    // ソルブの入った区切り（3D の一致が出たもの。なければ読みのいちばん多いもの）
    const seg = segs.find((s) => s.match3d !== null) ?? segs.sort((x, y) => y.frames - x.frames)[0];
    row.replay = seg ? { same: segs.reduce((n, s) => n + s.same, 0), differ: segs.reduce((n, s) => n + s.differ, 0), match3d: seg.match3d, anim3d: seg.anim3d } : { error: `終了コード ${r.code}` };
  }
  rows.push(row);
}
// 録画のないライブの記録（組にならなかったもの）
for (const l of lives.filter((l) => !l.used)) rows.push({ file: null, live: l.file.split("/").pop(), note: "録画がない（組にならなかった）" });

const ANALYSIS = { done: "確定", partial: "一部推定", failed: "速報値", pending: "解析中", error: "失敗", none: "-" };
const STAGE = { first: "1 回目", "deep-tried": "深い(1 回目)", deep: "深い", pieces: "ピース" };
const WHY = { result: "結果", error: "失敗", next: "次", guard: "保険" };
const n1 = (x) => (x === undefined || x === null || !Number.isFinite(x) ? "-" : Number(x).toFixed(1));
const pct = (x) => (x === undefined || x === null ? "-" : `${Math.round(x * 100)}%`);
const stamp = (d) => {
  if (!d) return "-";
  const t = new Date(d);
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getMonth() + 1}/${t.getDate()} ${p(t.getHours())}:${p(t.getMinutes())}`;
};
const head = ["録画", "ライブの記録", "日時", "配置", "タイム", "解析", "推定/手", "段", "待ち", "渡し方 ライブ・録画（一時）", "休み", "カメラ fps", "ライブ 枚/秒", "マス（中央）", "面なし", "録画 抜け・間引き", "3D の一致（手元）", "ライブ 実機と同じ", "アプリの結果と同じ", "精密解析の読めたマス（平均）", "誤読"];
const md = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
for (const r of rows) {
  const s = r.summary;
  if (!s) {
    md.push(`| - | ${r.live} | ${r.note} |${" |".repeat(head.length - 3)}`);
    continue;
  }
  const fp = s.framePath;
  const cells = [
    r.file,
    r.live ?? "-",
    stamp(r.date),
    LAYOUT_LABEL[r.layout] ?? r.layout,
    s.timeMs !== undefined ? `${(s.timeMs / 1000).toFixed(2)} 秒` : "-",
    `${ANALYSIS[s.analysis] ?? s.analysis}${s.method ? `（${s.method}）` : ""}`,
    s.moves !== undefined ? `${s.inferred}/${s.moves}` : "-",
    `${s.stage ? (STAGE[s.stage] ?? s.stage) : "-"}${s.retried ? "・やり直し" : ""}`,
    s.waitMs !== undefined ? `${(s.waitMs / 1000).toFixed(1)} 秒` : "-",
    fp ? `${fp.live}・${fp.recorder}（${fp.liveWaits ?? 0}・${fp.recorderWaits ?? 0}）` : "-",
    s.rests.length ? s.rests.map((x) => `${x.from.toFixed(1)}〜${x.to !== undefined ? x.to.toFixed(1) : "?"}（${WHY[x.why] ?? "続く"}）`).join(" ") : "-",
    n1(s.camFps),
    n1(s.liveFps),
    s.cellsMedian ?? "-",
    pct(s.noFace),
    s.rec ? `${s.rec.holes}（${s.rec.missing} 枚）・${s.rec.dropped ?? "-"}` : "-",
    r.replay ? (r.replay.error ?? `${n1(r.replay.match3d)}%`) : "-",
    r.replay && !r.replay.error ? `${r.replay.same}/${r.replay.same + r.replay.differ}` : "-",
    r.refine ? (r.refine.error ?? (r.refine.sameAsApp === null ? "-" : r.refine.sameAsApp ? "はい" : "いいえ")) : "-",
    r.stats ? r.stats.cells.toFixed(2) : "-",
    r.stats?.misread !== undefined ? `${(r.stats.misread * 100).toFixed(2)}%` : "-",
  ];
  md.push(`| ${cells.join(" | ")} |`);
}
// --group stickers: 配置ごとに、この表の列の中央の行と、recordingStats と同じ「配置ごと」の表
if (group === "stickers") {
  const solves = rows.filter((r) => r.summary);
  md.push("", "配置ごとの中央（1 本ごとの値の中央。解析は確定の本数・完成の本数）:", "", "| 配置 | 本数 | タイム | 確定 | 推定 | 待ち | カメラ fps | ライブ 枚/秒 | マス（中央） | 面なし | 録画 抜け | 3D の一致（手元） | アプリの結果と同じ | 精密解析の読めたマス | 誤読 |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const lay of [...new Set(solves.map((r) => r.layout))]) {
    const g = solves.filter((r) => r.layout === lay);
    const med = (f) => medianOf(g.map(f));
    const sm = (f, d = 1) => {
      const x = med(f);
      return Number.isNaN(x) ? "-" : x.toFixed(d);
    };
    const same = g.filter((r) => r.refine && !r.refine.error && r.refine.sameAsApp !== null);
    md.push(
      `| ${LAYOUT_LABEL[lay] ?? lay} | ${g.length} | ${sm((r) => (r.summary.timeMs ?? NaN) / 1000, 2)} 秒 | ${g.filter((r) => r.summary.analysis === "done").length}/${g.length} | ${sm((r) => r.summary.inferred)} | ${sm((r) => (r.summary.waitMs ?? NaN) / 1000)} 秒 | ${sm((r) => r.summary.camFps)} | ${sm((r) => r.summary.liveFps)} | ${sm((r) => r.summary.cellsMedian)} | ${Number.isNaN(med((r) => r.summary.noFace)) ? "-" : `${Math.round(med((r) => r.summary.noFace) * 100)}%`} | ${sm((r) => r.summary.rec?.holes, 0)} | ${Number.isNaN(med((r) => r.replay?.match3d ?? undefined)) ? "-" : `${sm((r) => r.replay?.match3d ?? undefined)}%`} | ${same.length ? `${same.filter((r) => r.refine.sameAsApp).length}/${same.length}` : "-"} | ${sm((r) => r.stats?.cells, 2)} | ${Number.isNaN(med((r) => r.stats?.misread)) ? "-" : `${(med((r) => r.stats?.misread) * 100).toFixed(2)}%`} |`,
    );
  }
  const stats = solves.map((r) => r.stats).filter(Boolean);
  if (stats.length) md.push("", "recordingStats の「配置ごと」と同じ表（realVideo の読める量の物差し）:", "", ...layoutTable(stats));
  else md.push("", "（--no-refine のときは読める量の物差しがない）");
}
const text = md.join("\n");
console.log(text);
if (opt("--md")) writeFileSync(opt("--md"), `${text}\n`);
if (opt("--json")) writeFileSync(opt("--json"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

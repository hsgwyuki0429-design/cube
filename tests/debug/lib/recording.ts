// 設定画面の「録画を書き出す」で書き出した録画（src/ui/recordingExport.ts・src/vision/mp4Mux.ts）を手元で読む。
// - 映像は ffmpeg で YUV（yuv420p）のまま取り出し、本体と同じ planesToRgba（src/vision/framePixels.ts）で RGBA にする（圧縮し直さない・縮めない。
//   H.264 の復号は決まった結果になるので、本体が YUV のまま取り出していれば（decodeInfo.copied = decoded）本体と同じ画素になる）
// - 時刻は本体と同じ performance.now() の時間軸の ms（動画の pts（µs）+ timeOriginUs）
// - 精密解析を本体と同じフレームの扱いで通し直すための決まり（exportPlan）と、本体の結果との比べ（compareResults）
// - 実機の録画を x264 と比べる物差し（readStats）: 1 フレームに読めたマス・ピース、確かな読みのない区間、実際の fps・抜け
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { MOVE_NAMES } from "../../../src/cube/model";
import { buildSights } from "../../../src/track/pieces/decode";
import { PIECE_OF } from "../../../src/track/pieces/model";
import { CENTER_SLOT, bitsOf, buildTable } from "../../../src/track/pieces/table";
import type { SightFrame } from "../../../src/track/sight";
import { planesToRgba } from "../../../src/vision/framePixels";
import { gunzipSync } from "node:zlib";
import { LIVE_LOG_UUID, readRecordingMeta, readUuidBox } from "../../../src/vision/mp4Mux";
import type { SolveSummary } from "../../../src/app/solveSummary";
import type { RefineInput, RefineResult } from "../../../src/vision/refine";

export interface ExportMeta {
  kind: "cubevision-recording";
  version: number;
  timeOriginUs: number;
  recorder: { codec: string; hw: string | null; bitrate: number; width: number; height: number; framerate: number; frames: number; dropped: number; chunks: number; keyframes: number; bytes: number };
  camera?: unknown;
  stats?: unknown;
  device?: { ua: string };
  analysis: {
    input: RefineInput;
    solvingFrom?: number;
    target: number[] | null;
    live?: { solveId: string; startT: number; endT: number; how: string };
    result?: RefineResult;
    error?: string;
    retried?: string;
    pending?: boolean;
    waitMs?: number; // 止めてから解析の結果が出るまで（2026-11-27 から）
    solveLoad?: string; // URL の ?solveload=
  };
  solve?: { timeMs: number; edges?: unknown; analysis?: string; refineMethod?: string; moves?: unknown[] };
  perf?: import("../../../src/app/perfLog").PerfRow[]; // 1 秒ごとの処理の様子（2026-11-27 から）
  rests?: import("../../../src/app/liveRest").RestSpan[]; // 止めた後にライブが休んだ区間
  summary?: SolveSummary; // 開発用の「書き出す」（まとめたファイル: src/ui/bundleExport.ts）の最後のソルブの様子
  bundle?: { version: number; liveLog: string; liveGzip: boolean };
  pair?: { solveId: string | null; recFrom: number; timeOriginUs: number | null; startT: number | null; endT: number | null };
  framePath?: { live: string; liveNote: string | null; liveWaits?: number; liveWaitNote?: string | null; recorder: string; recorderNote: string | null; recorderWaits?: number; recorderWaitNote?: string | null; requested: boolean }; // カメラのフレームの渡し方（waits: 一時的に渡さなかった回数）
}

// 書き出した録画なら、そのメタデータ（ふつうの動画なら null）
export function loadExport(file: string): ExportMeta | null {
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch {
    return null;
  }
  const m = readRecordingMeta(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  return m && m.kind === "cubevision-recording" ? (m as unknown as ExportMeta) : null;
}

// まとめたファイル（開発用の「書き出す」）に入っているライブの記録（「ライブの記録を書き出す」と同じ形）。なければ null
export function loadBundleLive(file: string): Record<string, any> | null {
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch {
    return null;
  }
  const body = readUuidBox(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), LIVE_LOG_UUID);
  if (!body) return null;
  const raw = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : Buffer.from(body);
  return JSON.parse(raw.toString("utf8"));
}

// ライブの記録を読む: .json・.json.gz（「ライブの記録を書き出す」）か、まとめたファイル（.mp4）
export function loadLiveLog(file: string): Record<string, any> {
  if (/\.(mp4|mov)$/i.test(file)) {
    const live = loadBundleLive(file);
    if (!live) throw new Error(`ライブの記録が入っていない（まとめたファイルではない）: ${file}`);
    return live;
  }
  const raw = readFileSync(file);
  return JSON.parse((raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString("utf8"));
}

// フレームの時刻（µs。本体の時間軸）
export function exportTimesUs(file: string, meta: ExportMeta): number[] {
  const out = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts", "-of", "csv=p=0", file], { encoding: "utf8", maxBuffer: 1 << 26 }).stdout;
  return out
    .trim()
    .split("\n")
    .map((l) => meta.timeOriginUs + Number.parseInt(l, 10));
}

type Img = { data: Uint8ClampedArray; width: number; height: number };

// 1 フレームずつ（tUs: 本体の時間軸の µs）。each が false を返したらやめる
export async function readExportFrames(file: string, meta: ExportMeta, each: (img: Img, tUs: number, k: number) => boolean | void): Promise<number> {
  const { width: W, height: H } = meta.recorder;
  const times = exportTimesUs(file, meta);
  const info = meta.analysis.result?.decodeInfo;
  // 復号したままの YUV（yuv420p か、全範囲の yuvj420p）。-pix_fmt yuv420p にすると、全範囲の映像は ffmpeg が限られた範囲に直してしまう
  const fmt = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", file], { encoding: "utf8" }).stdout.trim();
  if (fmt !== "yuv420p" && fmt !== "yuvj420p") throw new Error(`この画素の形式は読めない: ${fmt}`);
  const proc = spawn("ffmpeg", ["-v", "error", "-i", file, "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", fmt, "-"]);
  const size = (W * H * 3) / 2;
  const planes = [
    { offset: 0, stride: W },
    { offset: W * H, stride: W / 2 },
    { offset: W * H + (W * H) / 4, stride: W / 2 },
  ];
  let buf = Buffer.alloc(0);
  let k = 0;
  for await (const chunk of proc.stdout) {
    buf = Buffer.concat([buf, chunk as Buffer]);
    while (buf.length >= size) {
      const yuv = new Uint8Array(buf.buffer, buf.byteOffset, size);
      const data = planesToRgba(yuv, planes, "I420", W, H, info?.matrix, info?.fullRange);
      buf = buf.subarray(size);
      if (each({ data, width: W, height: H }, times[k], k) === false) {
        proc.kill();
        return k + 1;
      }
      k++;
    }
  }
  return k;
}

// 本体の精密解析と同じフレームの扱い（vision.worker.ts）:
// - ソルブ中から進めた解析（decodeInfo.stream）: 回し始めの知らせが届くまで（solvingAt までのフレーム）は 60ms に 1 枚、その後は
//   回し始めの少し前（solvingFrom）から全部。止めた知らせが届いた後（endAt より後のフレーム）は解析の範囲の終わり（to）と止めた時刻（stop）を
//   知っていて、間引きの境は fullFrom
// - 録画全体のやり直し（retried）: 範囲 from〜to だけ、インスペクションの終わり（inspectUntil）より前は 60ms に 1 枚
export interface ExportPlan {
  mode: "stream" | "rerun";
  input: RefineInput; // Refiner に渡す（stream では to と stop は後で: endAt を過ぎたら setEnd・setStop）
  inspectUntil?: number; // setInspectUntil
  thinBefore: (t: number) => number; // このフレームの時刻での間引きの境（これより前は 60ms に 1 枚）
  endAt: number | null; // stream: このフレームより後で setEnd(to)・setStop(stop)
  to: number;
  stop: RefineInput["stop"];
  keep: (t: number) => boolean; // rerun: 範囲の中だけ
  note: string;
}

export function exportPlan(meta: ExportMeta): ExportPlan {
  const a = meta.analysis;
  const input = a.input;
  const st = a.result?.decodeInfo?.stream;
  const to = input.to;
  // 録画の始まりからの秒（知らせが来たときに最後に来ていたフレーム）
  const rel = (t: number | null, before: string) => (t === null ? "なし" : Number.isFinite(t) ? `${((t - meta.timeOriginUs / 1000) / 1000).toFixed(3)}s のフレームの後` : before);
  if (st && !a.retried) {
    const final = st.fullFrom;
    return {
      mode: "stream",
      input: { ...input, to: Infinity, stop: undefined, inspectUntil: undefined },
      inspectUntil: st.solvingAt !== null ? a.solvingFrom : undefined,
      thinBefore: (t) => (st.endAt !== null && t > st.endAt ? final : st.solvingAt !== null && t > st.solvingAt ? (a.solvingFrom ?? Infinity) : Infinity),
      endAt: st.endAt,
      to,
      stop: input.stop,
      keep: () => true,
      note: `ソルブ中から進めた解析（回し始めの知らせ ${rel(st.solvingAt, "最初のフレームの前")}・止めた知らせ ${rel(st.endAt, "最初のフレームの前")}）`,
    };
  }
  const iu = input.inspectUntil ?? -Infinity;
  return {
    mode: "rerun",
    input,
    inspectUntil: Number.isFinite(iu) ? iu : undefined,
    thinBefore: () => iu,
    endAt: null,
    to,
    stop: input.stop,
    keep: (t) => t >= input.from && t <= to,
    note: a.retried ? `録画全体のやり直し（${a.retried}）` : "録画全体の解析（stream の情報なし）",
  };
}

// 本体の結果と、手元で解析し直した結果を比べる（同じなら空）
export function compareResults(app: RefineResult, mine: RefineResult): string[] {
  const diff: string[] = [];
  const nm = (r: RefineResult) => r.moves.map((m) => `${MOVE_NAMES[m.move]}${m.inferred ? "?" : ""}`).join(" ");
  if (nm(app) !== nm(mine)) diff.push(`手順: アプリ ${nm(app)} / 手元 ${nm(mine)}`);
  for (const k of ["solved", "method", "start", "end", "startUncertain", "endUncertain", "startMoveInferred", "endMoveInferred", "inferred", "forced", "gapped", "endApproxMs"] as const) {
    if (JSON.stringify(app[k] ?? null) !== JSON.stringify(mine[k] ?? null)) diff.push(`${k}: アプリ ${JSON.stringify(app[k])} / 手元 ${JSON.stringify(mine[k])}`);
  }
  if (JSON.stringify(app.stopCut ?? null) !== JSON.stringify(mine.stopCut ?? null)) diff.push(`stopCut: アプリ ${JSON.stringify(app.stopCut)} / 手元 ${JSON.stringify(mine.stopCut)}`);
  const n = Math.min(app.moves.length, mine.moves.length);
  let timing = 0;
  for (let i = 0; i < n; i++) if (app.moves[i].start !== mine.moves[i].start || app.moves[i].end !== mine.moves[i].end) timing++;
  if (timing) diff.push(`手の時刻が違う手 ${timing}/${n}`);
  return diff;
}

// ---- 読める量の物差し（実機の録画と x264 を同じ物差しで比べる） ----

export interface StatFrame {
  t: number;
  cells: number; // ID が読めたマス
  pieces: number; // ID が読めたピース（同じピースのステッカーは 1 つ）
}

export function statFrame(t: number, faces: { ids?: number[] }[]): StatFrame {
  const seen = new Set<number>();
  let cells = 0;
  for (const f of faces)
    for (const id of f.ids ?? []) {
      if (id < 0) continue;
      cells++;
      const p = PIECE_OF[id];
      seen.add(p >= 0 ? p : 100 + Math.floor(id / 9)); // センターは面ごと
    }
  return { t, cells, pieces: seen.size };
}

// 確かな読み（src/track/pieces/solve.ts の strongOf と同じ決め方: 置き方が推測に頼らないまとまりで、続いた読みの重みが bitsOf(0.02) 以上。
// センター 1 つの面はセンターの向きの読みも確かなとき）のある見え方の時刻
// sureOnly: 置き方の決まった面の読みだけ（センター 1 つの面を数えない）
export function strongSpans(sights: SightFrame[], sureOnly = false): { t0: number; t1: number }[] {
  if (!sights.length) return [];
  const strong = bitsOf(0.02);
  const table = buildTable(sights);
  const out: { t0: number; t1: number }[] = [];
  for (const sg of buildSights(table)) {
    let ok = false;
    for (const g of sg.groups) {
      if (!g.robust) continue;
      if (g.sure) {
        for (let i = 0; i < g.n && !ok; i++) if (g.A[i] !== 255 && g.R[i] >= strong && g.P[i] < CENTER_SLOT) ok = true;
      } else if (!sureOnly) {
        const ic = Array.from(g.P).findIndex((p) => p >= CENTER_SLOT);
        if (ic < 0 || g.R[ic] < strong) continue;
        for (let i = 0; i < g.n && !ok; i++) if (g.P[i] < CENTER_SLOT && g.R[i] >= strong) ok = true;
      }
      if (ok) break;
    }
    if (ok) out.push({ t0: sg.t0, t1: sg.t1 });
  }
  return out;
}

export interface ReadStats {
  range: [number, number]; // ms
  seconds: number;
  frames: number; // 範囲の中の録画のフレーム
  fps: number; // 範囲の中のフレーム ÷ 長さ
  medianMs: number; // フレームの間隔の中央
  holes: number; // 抜け（間隔が中央の 1.5 倍より長い所）の数
  missing: number; // 抜けで失ったとみられるフレームの数（間隔 ÷ 中央 − 1 の合計）
  refined: number; // 範囲の中で精密に処理したフレーム
  cells: number; // 精密に処理した 1 フレームに ID が読めたマス（平均）
  pieces: number; // 同じくピース
  gaps05: number; // 確かな読みのない 0.5 秒より長い区間の数
  gaps1: number; // 1 秒より長い区間の数
  gaps1Sec: number; // 1 秒より長い区間の合計（秒）
  longest: number; // いちばん長い区間（秒）
  gapSec: number; // 0.5 秒より長い区間の合計（秒）
  sure1Sec: number; // 置き方の決まった面の確かな読みだけで数えた 1 秒より長い区間の合計（秒。センター 1 つの面を数えない）
  sureLongest: number;
}

export function readStats(range: [number, number], timesMs: number[], frames: StatFrame[], sights: SightFrame[]): ReadStats {
  const [r0, r1] = range;
  const ts = timesMs.filter((t) => t >= r0 && t <= r1);
  const dts: number[] = [];
  for (let i = 1; i < ts.length; i++) dts.push(ts[i] - ts[i - 1]);
  const sorted = [...dts].sort((a, b) => a - b);
  const med = sorted.length ? sorted[sorted.length >> 1] : 0;
  let holes = 0;
  let missing = 0;
  for (const d of dts)
    if (med && d > med * 1.5) {
      holes++;
      missing += Math.round(d / med) - 1;
    }
  const fr = frames.filter((f) => f.t >= r0 && f.t <= r1);
  const avg = (k: "cells" | "pieces") => (fr.length ? fr.reduce((n, f) => n + f[k], 0) / fr.length : 0);
  const gapsOf = (spans: { t0: number; t1: number }[]) => {
    const gaps: number[] = [];
    let prev = r0;
    for (const s of spans.filter((s) => s.t1 >= r0 && s.t0 <= r1)) {
      if (s.t0 > prev) gaps.push(s.t0 - prev);
      prev = Math.max(prev, s.t1);
    }
    if (r1 > prev) gaps.push(r1 - prev);
    return gaps;
  };
  const gaps = gapsOf(strongSpans(sights));
  const sureGaps = gapsOf(strongSpans(sights, true));
  const g05 = gaps.filter((g) => g > 500);
  const g1 = gaps.filter((g) => g > 1000);
  const sec = (x: number) => Math.round(x) / 1000;
  return {
    range,
    seconds: sec(r1 - r0),
    frames: ts.length,
    fps: ts.length > 1 ? Math.round(((ts.length - 1) / ((ts[ts.length - 1] - ts[0]) / 1000)) * 10) / 10 : 0,
    medianMs: Math.round(med * 10) / 10,
    holes,
    missing,
    refined: fr.length,
    cells: Math.round(avg("cells") * 100) / 100,
    pieces: Math.round(avg("pieces") * 100) / 100,
    gaps05: g05.length,
    gaps1: g1.length,
    gaps1Sec: sec(g1.reduce((a, b) => a + b, 0)),
    longest: sec(Math.max(0, ...gaps)),
    gapSec: sec(g05.reduce((a, b) => a + b, 0)),
    sure1Sec: sec(sureGaps.filter((g) => g > 1000).reduce((a, b) => a + b, 0)),
    sureLongest: sec(Math.max(0, ...sureGaps)),
  };
}

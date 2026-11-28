// 最後のソルブの様子の要約（開発用の書き出し: 止めた後の画面に小さく出し、書き出しにも入れる。src/ui/DevExport.tsx・src/ui/bundleExport.ts）。
// 止めた後の待ち・精密解析の結果（確定・一部推定・速報値・推定の手の数・解き直しの段）・フレームの渡し方・休みの区間・ソルブ中のカメラの fps・
// ライブの 1 秒の枚数・1 フレームに読めたマス（中央）・面が組めなかった割合・録画の抜け。
// DOM もカメラも知らない（手元の道具・scripts/real-table.mjs も同じものを使う。Node が型を消すだけで読めるように、型以外は import しない）
import type { FramePath } from "../vision/frameGate";
import type { PerfRow } from "./perfLog";
import type { RestSpan } from "./liveRest";

export const SUMMARY_VERSION = 1;

interface ReadingLike {
  t: number;
  faces: { ids?: number[]; valid?: boolean[] }[];
  sight?: { faces: { held?: boolean }[] };
}

export interface SummaryInput {
  solveId?: string;
  timeMs?: number; // 記録のタイム
  analysis?: string; // 記録の Solve.analysis（done・partial・failed・pending）
  waitMs?: number; // 止めてから解析の結果が出るまで
  result?: { solved: boolean; moves: { inferred?: boolean }[]; method?: string; decodeStage?: string } | null;
  error?: string;
  retried?: string; // ソルブ中から進めた解析が失敗し、録画全体を解析し直した理由
  startT?: number; // リアルタイムの開始・停止（フレームの時間軸の ms）
  endT?: number;
  framePath?: Partial<FramePath> | null;
  rests?: RestSpan[];
  perf?: PerfRow[];
  readings?: ReadingLike[]; // ライブの記録の読み
  recTimesMs?: number[]; // 録画のフレームの時刻（ms）
  recorder?: { frames: number; dropped: number } | null;
}

export interface SolveSummary {
  version: number;
  solveId?: string;
  timeMs?: number;
  analysis: string; // done・partial・failed・pending・error・none
  waitMs?: number;
  solved?: boolean;
  moves?: number;
  inferred?: number;
  method?: string;
  stage?: string; // first・deep-tried・deep・pieces（解き直しの段）
  retried?: string;
  error?: string;
  framePath?: { requested?: boolean; live?: string; liveNote?: string | null; liveWaits?: number; recorder?: string; recorderNote?: string | null; recorderWaits?: number };
  rests: { from: number; to?: number; why?: string }[]; // 止めた時刻からの秒
  solveSec?: number;
  camFps?: number; // ソルブ中のカメラのフレーム（1 秒あたり。1 秒ごとの処理の様子から）
  liveFps?: number; // ソルブ中にライブが認識した枚数（主 + 補助、1 秒あたり）
  liveMain?: number;
  liveHelper?: number;
  liveFrames?: number; // ソルブ中のライブの記録の読みの数
  cellsMedian?: number; // ソルブ中の 1 フレームに ID が読めたマス（中央）
  cellsMean?: number;
  noFace?: number; // ソルブ中に面が 1 つも組めなかったフレームの割合（0〜1。撮り方の案内と同じ決め方）
  rec?: { frames: number; fps: number; holes: number; missing: number; dropped?: number; total?: number }; // ソルブ中の録画（抜け = 間隔が中央の 1.5 倍より長い所）
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const median = (xs: number[]) => {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

// 1 秒ごとの処理の様子の、from〜to の 1 秒あたり（行の長さ = 次の行までの時間。全部入る行がなければ重なる行）
function perRow(rows: PerfRow[], from: number, to: number, f: (r: PerfRow) => number): number | undefined {
  if (!rows.length) return undefined;
  const sorted = [...rows].sort((a, b) => a.t - b.t);
  const dur = (i: number) => (i + 1 < sorted.length ? sorted[i + 1].t - sorted[i].t : 1000);
  let idx = sorted.map((_, i) => i).filter((i) => sorted[i].t >= from && sorted[i].t + dur(i) <= to);
  if (!idx.length) idx = sorted.map((_, i) => i).filter((i) => sorted[i].t < to && sorted[i].t + dur(i) > from);
  if (!idx.length) return undefined;
  let n = 0;
  let ms = 0;
  for (const i of idx) {
    n += f(sorted[i]);
    ms += dur(i);
  }
  return ms > 0 ? r1((n * 1000) / ms) : undefined;
}

export function summarizeSolve(x: SummaryInput): SolveSummary {
  const res = x.result ?? null;
  const out: SolveSummary = {
    version: SUMMARY_VERSION,
    ...(x.solveId ? { solveId: x.solveId } : {}),
    ...(x.timeMs !== undefined ? { timeMs: x.timeMs } : {}),
    analysis: res ? (x.analysis ?? "done") : x.error ? "error" : (x.analysis ?? "none"),
    ...(x.waitMs !== undefined ? { waitMs: x.waitMs } : {}),
    ...(x.retried ? { retried: x.retried } : {}),
    ...(x.error ? { error: x.error } : {}),
    rests: [],
  };
  if (res) {
    out.solved = res.solved;
    out.moves = res.moves.length;
    out.inferred = res.moves.filter((m) => m.inferred).length;
    if (res.method) out.method = res.method;
    if (res.decodeStage) out.stage = res.decodeStage;
  }
  const fp = x.framePath;
  if (fp) out.framePath = { requested: fp.requested, live: fp.live, liveNote: fp.liveNote ?? null, liveWaits: fp.liveWaits ?? 0, recorder: fp.recorder, recorderNote: fp.recorderNote ?? null, recorderWaits: fp.recorderWaits ?? 0 };
  const { startT: t0, endT: t1 } = x;
  const stop = t1 ?? t0;
  // 休み: このソルブを止めた後のもの（止めた時刻からの秒）
  if (stop !== undefined) out.rests = (x.rests ?? []).filter((r) => r.t0 >= stop - 2000 && r.t0 <= stop + 60000).map((r) => ({ from: r1((r.t0 - stop) / 1000), ...(r.t1 !== undefined ? { to: r1((r.t1 - stop) / 1000) } : {}), ...(r.why ? { why: r.why } : {}) }));
  if (t0 === undefined || t1 === undefined || t1 <= t0) return out;
  out.solveSec = r2((t1 - t0) / 1000);
  const perf = x.perf ?? [];
  out.camFps = perRow(perf, t0, t1, (r) => r.cam);
  out.liveFps = perRow(perf, t0, t1, (r) => r.live + r.helper);
  out.liveMain = perRow(perf, t0, t1, (r) => r.live);
  out.liveHelper = perRow(perf, t0, t1, (r) => r.helper);
  const rs = (x.readings ?? []).filter((r) => r.t >= t0 && r.t <= t1);
  if (rs.length) {
    const cells = rs.map((r) => r.faces.reduce((n, f) => n + (f.ids ?? []).filter((id, c) => id >= 0 && (!f.valid || f.valid[c])).length, 0));
    out.liveFrames = rs.length;
    out.cellsMedian = median(cells);
    out.cellsMean = r2(cells.reduce((a, b) => a + b, 0) / cells.length);
    out.noFace = r2(rs.filter((r) => (r.sight ? r.sight.faces.filter((f) => !f.held).length : r.faces.length) === 0).length / rs.length);
  }
  const ts = (x.recTimesMs ?? []).filter((t) => t >= t0 && t <= t1);
  if (ts.length > 1) {
    const dts = ts.slice(1).map((t, i) => t - ts[i]);
    const med = median(dts);
    let holes = 0;
    let missing = 0;
    for (const d of dts)
      if (med && d > med * 1.5) {
        holes++;
        missing += Math.round(d / med) - 1;
      }
    out.rec = { frames: ts.length, fps: r1((ts.length - 1) / ((ts[ts.length - 1] - ts[0]) / 1000)), holes, missing, ...(x.recorder ? { dropped: x.recorder.dropped, total: x.recorder.frames + x.recorder.dropped } : {}) };
  }
  return out;
}

const ANALYSIS: Record<string, string> = { done: "確定", partial: "一部推定", failed: "速報値", pending: "解析中", error: "解析の失敗", none: "解析なし" };
const STAGE: Record<string, string> = { first: "1 回目", "deep-tried": "深い解き直しもした・1 回目", deep: "深い解き直し", pieces: "ピース方式" };
const WHY: Record<string, string> = { result: "解析の結果", error: "解析の失敗", next: "次のソルブ", guard: "保険の 180 秒" };
const f1 = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? "-" : x.toFixed(1));

// 画面に出す行（文字だけ。スマホの幅で 1 行に収まるように短く）
export function summaryLines(s: SolveSummary): string[] {
  const lines: string[] = [];
  const how = [s.method, s.stage ? (STAGE[s.stage] ?? s.stage) : undefined, s.retried ? "録画全体のやり直し" : undefined].filter(Boolean).join("・");
  lines.push(`${ANALYSIS[s.analysis] ?? s.analysis}${s.solved === false ? "（完成しない）" : ""}${how ? `・${how}` : ""}${s.moves !== undefined ? `・推定 ${s.inferred}/${s.moves}` : ""}・待ち ${s.waitMs !== undefined ? `${(s.waitMs / 1000).toFixed(1)} 秒` : "-"}`);
  if (s.error) lines.push(s.error);
  const fp = s.framePath;
  if (fp) lines.push(`渡し方 ${fp.live ?? "-"}/${fp.recorder ?? "-"}（一時 ${fp.liveWaits ?? 0}/${fp.recorderWaits ?? 0}）${fp.requested === false ? "・default" : ""}${fp.liveNote ? `・${fp.liveNote}` : ""}${fp.recorderNote ? `・録画 ${fp.recorderNote}` : ""}`);
  if (s.solveSec !== undefined) lines.push(`ソルブ中 ${f1(s.camFps)}fps・ライブ ${f1(s.liveFps)}/秒・マス ${s.cellsMedian ?? "-"}・面なし ${s.noFace !== undefined ? `${Math.round(s.noFace * 100)}%` : "-"}`);
  if (s.rec) lines.push(`録画 抜け ${s.rec.holes}（${s.rec.missing} 枚）・間引き ${s.rec.dropped ?? "-"}${s.rec.total !== undefined ? `/${s.rec.total}` : ""}`);
  lines.push(`休み ${s.rests.length ? s.rests.map((r) => `${r.from.toFixed(1)}〜${r.to !== undefined ? r.to.toFixed(1) : "?"} 秒（${r.why ? (WHY[r.why] ?? r.why) : "続いている"}）`).join("・") : "なし"}`);
  return lines;
}

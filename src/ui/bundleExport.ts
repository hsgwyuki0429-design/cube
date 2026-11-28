// 開発用の「書き出す」（止めた後の画面: src/ui/DevExport.tsx。?debug か設定の「開発用の書き出し」がオンのとき）: 直近のソルブの録画（今の
// 「録画を書き出す」と同じ MP4・同じメタデータ）に、そのソルブを通し直せる範囲のライブの記録（今の「ライブの記録を書き出す」と同じ形を gzip して
// 別の uuid ボックス: src/vision/mp4Mux.ts の LIVE_LOG_UUID）と、最後のソルブの様子の要約（src/app/solveSummary.ts。メタデータの summary）を
// 入れた 1 つのファイルにする。ファイル名はソルブの日時・タイム・配置（cubevision-20261128-153012-12.34s-quad.mp4。1 個は -std）。
// 材料（ライブの記録・要約）は精密解析が終わったとき（controller.onCaptureSettled）に作っておく: 押したらすぐ共有シートに渡す（iPhone は
// 押してから時間がかかると共有シートを出せない）。ライブの記録は直近 120 秒しか残らないので、後で押しても同じソルブの分が入る。
// 手元では realVideo・liveLog・fpsPhases・recordingStats・scripts/real-table.mjs がこの 1 つのファイルをそのまま読む
import { STICKERS } from "../aruco/design";
import { type SolveRecording, controller } from "../app/controller";
import { settingsStore } from "../app/settings";
import { type SolveSummary, summarizeSolve } from "../app/solveSummary";
import { createStore } from "../app/store";
import { timerStore } from "../app/timer";
import { LIVE_LOG_UUID, muxRecording } from "../vision/mp4Mux";
import { gzip, liveLogData } from "./liveLogExport";
import { recordingMeta, shareOrSave } from "./recordingExport";

export const BUNDLE_VERSION = 1;
const LIVE_LEAD_MS = 2000; // ライブの記録は録画の始まり（インスペクションの始まり）のこの長さ前から通し直せる分

export const devExportOn = (s = settingsStore.get()) => s.debug || s.devExport;

// 止めた後の画面が読む: 直近のソルブの材料ができたか（rev は作り直すたびに増やす: 画面を描き直す）
export const bundleStore = createStore<{ rev: number }>({ rev: 0 });

// 止めたときのタイマーの場面（休み中に「次のソルブ」を押すとスクランブルが替わるので、止めた時点のものを記録に入れる）
const timerAtStop = new Map<string, { phase: string; startT: number; startIndex: number; scramble: number[] }>();
let prevPhase = timerStore.get().phase;
timerStore.subscribe((t) => {
  if (t.phase === prevPhase) return;
  prevPhase = t.phase;
  if (t.phase === "done" && t.result) {
    timerAtStop.clear();
    timerAtStop.set(t.result.id, { phase: t.phase, startT: t.startT, startIndex: t.startIndex, scramble: [...t.scramble] });
  }
});

const preparing = new WeakSet<SolveRecording>();

// 材料を作る（ライブの記録・要約）。オンでなければ作らない（作るのは解析の後だけ: 認識・追跡・精密解析は変えない）
export async function prepareBundle(cap: SolveRecording): Promise<void> {
  if (cap.bundle || preparing.has(cap) || !devExportOn() || (!cap.result && !cap.error)) return;
  preparing.add(cap);
  try {
    const log = await controller.vision?.liveLog(cap.input.from - LIVE_LEAD_MS);
    const solveId = cap.live?.solveId;
    const live = liveLogData(log ?? { version: 0, segments: [] }, solveId ? timerAtStop.get(solveId) : undefined);
    live.pair = pairOf(cap);
    const text = JSON.stringify(live);
    const gz = await gzip(text);
    const liveBytes = gz ? new Uint8Array(await gz.arrayBuffer()) : new TextEncoder().encode(text);
    cap.bundle = { live, liveBytes, liveGzip: !!gz, summary: summaryOf(cap, live) };
  } catch (e) {
    console.warn("書き出しの材料を作れませんでした", e);
  } finally {
    preparing.delete(cap);
    bundleStore.set((s) => ({ rev: s.rev + 1 }));
  }
}

controller.onCaptureSettled = (cap) => {
  bundleStore.set((s) => ({ rev: s.rev + 1 }));
  // 記録の analysis（確定・一部推定…）はタイマーが同じ結果を待って決める: その後で
  setTimeout(() => void prepareBundle(cap), 0);
};

// 同じソルブの組だと分かる印（録画のメタデータとライブの記録の両方に入れる）
function pairOf(cap: SolveRecording) {
  return { solveId: cap.live?.solveId ?? null, recFrom: cap.input.from, timeOriginUs: cap.recording.chunks[0]?.timestamp ?? null, startT: cap.live?.startT ?? null, endT: cap.live?.endT ?? null };
}

// 要約（記録の analysis は今の値で）
export function summaryOf(cap: SolveRecording, live = cap.bundle?.live): SolveSummary {
  const solve = cap.live ? timerStore.get().solves.find((x) => x.id === cap.live!.solveId) : undefined;
  const segs = ((live?.log as { segments?: { readings: never[] }[] } | undefined)?.segments ?? []).flatMap((s) => s.readings);
  return summarizeSolve({
    solveId: cap.live?.solveId,
    timeMs: solve?.timeMs,
    stickers: solve?.stickers ?? STICKERS.arucoDesign,
    analysis: solve?.analysis,
    waitMs: cap.waitMs,
    result: cap.result,
    error: cap.error,
    retried: cap.retried,
    startT: cap.live?.startT,
    endT: cap.live?.endT,
    framePath: controller.framePath(),
    rests: controller.perf.rests,
    perf: controller.perf.rows,
    readings: segs,
    recTimesMs: cap.recording.chunks.map((c) => c.timestamp / 1000),
    recorder: cap.recorder,
  });
}

// ファイル名: ソルブの日時（端末の時刻）・タイム・配置（quad = 4 個・std = 1 個）
export function bundleName(date: number, timeMs: number | undefined, penalty?: string, analysis?: string, stickers: string = STICKERS.arucoDesign): string {
  const d = new Date(date);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const time = penalty === "DNF" ? "DNF" : timeMs !== undefined && Number.isFinite(timeMs) ? `${(timeMs / 1000).toFixed(2)}s` : "time";
  const tag = analysis === "partial" ? "-partial" : analysis === "failed" ? "-failed" : "";
  const lay = stickers === "standard" ? "std" : "quad";
  return `cubevision-${stamp}-${time}-${lay}${tag}.mp4`;
}

export async function exportBundle(): Promise<void> {
  const cap = controller.lastRecording;
  if (!cap?.bundle) {
    controller.toast("書き出す材料がまだありません（精密解析が終わるのを待ってください）");
    return;
  }
  const summary = summaryOf(cap);
  const meta = { ...recordingMeta(cap), bundle: { version: BUNDLE_VERSION, liveLog: LIVE_LOG_UUID, liveGzip: cap.bundle.liveGzip }, summary, pair: pairOf(cap) };
  let muxed: ReturnType<typeof muxRecording>;
  try {
    muxed = muxRecording(cap.recording, meta, [{ uuid: LIVE_LOG_UUID, data: cap.bundle.liveBytes }]);
  } catch (e) {
    controller.toast(`書き出せませんでした（${(e as Error).message}）`);
    return;
  }
  const solve = cap.live ? timerStore.get().solves.find((x) => x.id === cap.live!.solveId) : undefined;
  const name = bundleName(solve?.date ?? Date.now(), solve?.timeMs, solve?.penalty, solve?.analysis, solve?.stickers ?? STICKERS.arucoDesign);
  const file = new File(muxed.parts as BlobPart[], name, { type: "video/mp4" });
  await shareOrSave(file, `書き出しました（${muxed.frames} フレーム・${(file.size / 1e6).toFixed(1)}MB）`);
}

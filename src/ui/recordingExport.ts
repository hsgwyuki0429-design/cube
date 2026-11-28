// 「録画を書き出す」（設定画面。開発用）: 直近のソルブの録画（精密解析に渡した、圧縮したままの映像）を MP4 にまとめ、録画の設定・
// 間引いたフレームの数・タイマーの開始と停止（Solve.edges）・精密解析の入力と結果をメタデータとして入れて、共有シート（できなければ保存）に渡す。
// 手元では tests/debug/realVideo.debug.test.ts に REAL_VIDEO=書き出したファイル で通す（圧縮し直さずに読み、始まりの状態・ソルブの範囲・
// 解析の設定は書き出しから取る）。映像は端末の外に勝手に送らない: 書き出すのは利用者がボタンを押したときだけ
import { STICKERS } from "../aruco/design";
import { controller } from "../app/controller";
import { settingsStore } from "../app/settings";
import { timerStore } from "../app/timer";
import { muxRecording } from "../vision/mp4Mux";

export const RECORDING_EXPORT_VERSION = 1;

export async function exportRecording(): Promise<void> {
  const cap = controller.lastRecording;
  if (!cap) {
    controller.toast("書き出す録画がありません（タイマーで計ったソルブの録画を、次のソルブを始めるまで残します）");
    return;
  }
  const st = controller.store.get();
  const t = timerStore.get();
  const s = settingsStore.get();
  const solve = cap.live ? t.solves.find((x) => x.id === cap.live!.solveId) : undefined;
  const chunks = cap.recording.chunks;
  let bytes = 0;
  for (const c of chunks) bytes += c.data.byteLength;
  const meta = {
    kind: "cubevision-recording",
    version: RECORDING_EXPORT_VERSION,
    date: new Date().toISOString(),
    url: location.search,
    // ステッカーのマーカーの配置（?stickers=。精密解析の入力の pipeline.arucoDesign と同じ。手元の解析し直しはこれに従う）
    stickers: STICKERS.arucoDesign,
    device: { ua: navigator.userAgent, cores: navigator.hardwareConcurrency ?? 0, dpr: window.devicePixelRatio, screen: [screen.width, screen.height] },
    camera: st.cameraInfo,
    stats: st.stats,
    settings: { workWidth: s.workWidth, cameraFps: s.cameraFps, resolution: s.resolution, inspection: s.inspection },
    // 録画の設定（hw = 頼んだハードウェアの使い方）と数（frames = 圧縮に回したフレーム・dropped = 圧縮が追いつかずに間引いたフレーム）
    recorder: { ...cap.recorder, config: { codec: cap.recording.config.codec, codedWidth: cap.recording.config.codedWidth, codedHeight: cap.recording.config.codedHeight, colorSpace: cap.recording.config.colorSpace }, chunks: chunks.length, keyframes: chunks.filter((c) => c.type === "key").length, bytes },
    // 精密解析: input = 解析に渡したもの（時刻は performance.now() の時間軸の ms。録画の時刻 = timeOriginUs / 1000 + 動画の時刻）
    analysis: { input: cap.input, solvingFrom: cap.solvingFrom, target: cap.target, live: cap.live, result: cap.result, error: cap.error, retried: cap.retried, pending: !cap.result && !cap.error, waitMs: cap.waitMs, solveLoad: cap.solveLoad },
    // 記録（タイム・手順・開始と停止の理由 edges・精密解析の方法）
    solve,
    // 1 秒ごとの処理の様子（src/app/perfLog.ts）: 録画の始まりから
    perf: controller.perf.between(cap.input.from - 30000),
    rests: controller.perf.rests.filter((r) => (r.t1 ?? Infinity) >= cap.input.from),
    framePath: controller.framePath(),
  };
  let muxed: ReturnType<typeof muxRecording>;
  try {
    muxed = muxRecording(cap.recording, meta);
  } catch (e) {
    controller.toast(`録画を書き出せませんでした（${(e as Error).message}）`);
    return;
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const name = `cubevision-rec-${stamp}.mp4`;
  const file = new File(muxed.parts as BlobPart[], name, { type: "video/mp4" });
  const mb = (file.size / 1e6).toFixed(1);
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  controller.toast(`録画を保存しました（${muxed.frames} フレーム・${mb}MB）`);
}

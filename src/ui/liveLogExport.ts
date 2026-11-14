// 「ライブの記録を書き出す」（設定画面）: 認識の Worker が残しているライブの記録（src/track/liveLog.ts）に、端末・カメラ・直前のソルブを
// 添えて 1 つのファイルにし、共有シート（できなければ保存）に渡す。手元では tests/debug/liveLog.debug.test.ts で同じ追跡を通し直す。
// 映像は入れない（読み取ったマーカーの ID・色・位置だけ）
import { controller } from "../app/controller";
import { settingsStore } from "../app/settings";
import { timerStore } from "../app/timer";

async function gzip(text: string): Promise<Blob | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    return await new Response(stream).blob();
  } catch {
    return null;
  }
}

export async function exportLiveLog(): Promise<void> {
  const vision = controller.vision;
  if (!vision) {
    controller.toast("カメラを開始してから書き出してください");
    return;
  }
  const log = (await vision.liveLog()) as { segments?: { readings: unknown[] }[] } | null;
  const frames = log?.segments?.reduce((n, s) => n + s.readings.length, 0) ?? 0;
  if (!log || !frames) {
    controller.toast("書き出すライブの記録がありません（キューブを追跡している間の記録を残します）");
    return;
  }
  const st = controller.store.get();
  const t = timerStore.get();
  const s = settingsStore.get();
  const data = {
    kind: "cubevision-live-log",
    date: new Date().toISOString(),
    device: { ua: navigator.userAgent, cores: navigator.hardwareConcurrency ?? 0, dpr: window.devicePixelRatio, screen: [screen.width, screen.height] },
    camera: st.cameraInfo,
    stats: st.stats,
    settings: { viewpoint: s.viewpoint, notation: s.notation, workWidth: s.workWidth, cameraFps: s.cameraFps, resolution: s.resolution },
    helperFrames: vision.helperFrames,
    timer: { phase: t.phase, startT: t.startT, startIndex: t.startIndex, scramble: t.scramble },
    // 直前のソルブ（精密解析の手順と時刻: 本当の動きとして比べる）
    solves: t.solves.slice(-3),
    log,
  };
  const text = JSON.stringify(data);
  const gz = await gzip(text);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const name = `cubevision-live-${stamp}.json${gz ? ".gz" : ""}`;
  const file = new File([gz ?? text], name, { type: gz ? "application/gzip" : "application/json" });
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
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  controller.toast(`ライブの記録を保存しました（${frames} フレーム）`);
}

// 動画ファイル（スマホのカメラアプリで撮ったスロー撮影など）を読み込んで精密解析する。ブラウザのカメラは 60fps 前後までなので、
// 速い回転を細かく見たいときは、カメラアプリのスロー撮影（120 / 240fps）で撮った動画を後から解析する。
// timer: 表示したスクランブルから解いた動画 → タイムと手順を記録に足す。free: 揃った状態から回した動画 → 手順を出す
import { useEffect, useRef, useState } from "preact/hooks";
import { VIDEO_MAX_FPS, controller } from "../app/controller";
import { formatTime } from "../app/storage";
import { addVideoSolve, timerStore } from "../app/timer";
import { MOVE_NAMES, applyMoves, solvedState } from "../cube/model";
import { randomScramble } from "../cube/solver";
import type { RefineResult } from "../vision/refine";
import { videoStride } from "../vision/videoFile";

interface FileInfo {
  fps: number;
  durationMs: number;
  width: number;
  height: number;
  frames: number;
}

type Phase = "select" | "running" | "done" | "error";

export function VideoAnalysis({ mode, onClose }: { mode: "timer" | "free"; onClose: () => void }) {
  const [scramble, setScramble] = useState<number[]>(() => (mode === "timer" ? timerStore.get().scramble : []));
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [captureFps, setCaptureFps] = useState("");
  const [endSolved, setEndSolved] = useState(true);
  const [phase, setPhase] = useState<Phase>("select");
  const [progress, setProgress] = useState(0);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const [result, setResult] = useState<RefineResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [timeMs, setTimeMs] = useState<number | null>(null);
  const job = useRef<{ cancel: () => void } | null>(null);

  // タイマー: スクランブルがまだなければ作る（揃った状態から回してから撮影する）
  useEffect(() => {
    if (mode === "timer" && !scramble.length) void randomScramble().then(setScramble);
  }, []);
  useEffect(() => () => job.current?.cancel(), []);
  useEffect(() => {
    if (phase !== "running") return;
    const id = window.setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(id);
  }, [phase]);

  const pick = async (f: File | null) => {
    setFile(f);
    setInfo(null);
    setFileError(null);
    setResult(null);
    setMessage(null);
    setPhase("select");
    if (!f) return;
    try {
      // 見出し（moov）だけ読んで、fps・長さを出す
      const { demuxFile } = await import("../aruco/demux");
      const d = await demuxFile(f);
      const rotated = d.rotation === 90 || d.rotation === 270;
      setInfo({ fps: d.fps, durationMs: d.durationMs, width: rotated ? d.height : d.width, height: rotated ? d.width : d.height, frames: d.samples.length });
      setCaptureFps(String(Math.round(d.fps)));
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    }
  };

  const fps = Number(captureFps) > 0 ? Number(captureFps) : (info?.fps ?? 0);
  const realMs = info ? (info.durationMs * info.fps) / Math.max(1, fps) : 0;
  const analyzed = info ? Math.ceil(info.frames / videoStride(fps || info.fps, VIDEO_MAX_FPS)) : 0;

  const start = () => {
    if (!file || !info) return;
    const state = mode === "timer" ? applyMoves(solvedState(), scramble) : solvedState();
    const target = mode === "timer" || endSolved ? solvedState() : null;
    setPhase("running");
    setProgress(0);
    setStartedAt(performance.now());
    setNow(performance.now());
    setResult(null);
    setMessage(null);
    setTimeMs(null);
    const run = controller.analyzeVideo(file, { state, target, captureFps: fps }, setProgress);
    job.current = run;
    run.result.then(
      (r) => {
        job.current = null;
        setResult(r);
        setPhase("done");
        if (mode === "timer") {
          const added = addVideoSolve(r, scramble);
          if ("solve" in added) {
            setTimeMs(added.solve.timeMs);
            setMessage("記録に追加しました（履歴に「動画」と出ます）");
          } else setMessage(added.error);
        } else if (r.start !== null && r.end !== null && r.moves.length) setTimeMs(r.end - r.start);
        if (mode === "free" && target && !r.solved) setMessage("揃った状態までの手順をつなげられませんでした（途中まで前向きにたどった結果を出しています）");
      },
      (e) => {
        job.current = null;
        setMessage(e instanceof Error ? e.message : String(e));
        setPhase("error");
      },
    );
  };

  const elapsed = (now - startedAt) / 1000;
  const eta = progress > 0.03 ? Math.max(0, (elapsed * (1 - progress)) / progress) : null;
  const moves = result?.moves ?? [];

  return (
    <div class="result-block video-analysis" data-phase={phase}>
      <div class="result-head">
        {mode === "timer" ? "スロー動画から記録" : "動画を解析"}
        <span class="spacer" />
        <button class="btn small" onClick={() => (job.current?.cancel(), onClose())}>
          閉じる
        </button>
      </div>
      <p class="muted small" style={{ marginTop: 0 }}>
        アプリのカメラ（ブラウザ）は 60fps 前後までです。速い回転を細かく見たいときは、スマホのカメラアプリのスロー撮影（120・240fps）で撮った動画を読み込むと、
        全フレームを精密解析します（{VIDEO_MAX_FPS}fps を超える分は間引きます）。映像はこの端末の中で解析し、どこにも送りません。
      </p>
      {mode === "timer" ? (
        <>
          <div class="muted small">1. 揃った状態から、このスクランブルで崩してください（白上・緑前）</div>
          <div class="scramble">{scramble.length ? scramble.map((m, i) => <span key={i} class="mv">{MOVE_NAMES[m]}</span>) : <span class="muted small">スクランブルを生成中…</span>}</div>
          <div class="muted small">2. カメラアプリのスロー撮影で、解き始める前から揃え終わるまでを撮影して、動画を選んでください</div>
        </>
      ) : (
        <>
          <div class="muted small">揃った状態から回し始めた動画を選んでください（正面・上面がよく写るように）</div>
          <label class="small" style={{ display: "block", margin: "6px 0" }}>
            <input type="checkbox" checked={endSolved} onChange={(e) => setEndSolved((e.target as HTMLInputElement).checked)} /> 最後に揃った状態に戻した
          </label>
        </>
      )}
      <div style={{ margin: "8px 0" }}>
        <input type="file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v" disabled={phase === "running"} onChange={(e) => void pick((e.target as HTMLInputElement).files?.[0] ?? null)} />
      </div>
      {fileError && <p class="small" style={{ color: "var(--bad, #e66)" }}>{fileError}</p>}
      {info && (
        <>
          <div class="muted small">
            {info.width}×{info.height}・ファイルの {info.fps.toFixed(0)}fps・{info.frames} フレーム・実際の長さ {(realMs / 1000).toFixed(1)} 秒・解析するのは約 {analyzed} フレーム
          </div>
          <label class="small" style={{ display: "block", margin: "6px 0" }}>
            撮影した fps{" "}
            <input type="number" min={1} max={1000} step={1} style={{ width: 70 }} value={captureFps} disabled={phase === "running"} onInput={(e) => setCaptureFps((e.target as HTMLInputElement).value)} />
          </label>
          <p class="muted small" style={{ marginTop: 0 }}>
            共有・書き出しでスロー再生の動画（30fps など）に変換されたときは、撮影した fps（240 など）を入れると時間を実際の時間に直します。
            元のファイル（AirDrop の「すべての写真データ」など）ならそのままで大丈夫です。
          </p>
        </>
      )}
      {phase !== "running" && (
        <div class="btn-row">
          <button class="btn primary" disabled={!info || (mode === "timer" && !scramble.length)} onClick={start}>
            解析する
          </button>
        </div>
      )}
      {phase === "running" && (
        <div>
          <div class="progress" style={{ margin: "8px 0" }}>
            <div style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <div class="muted small">
            解析中 {Math.round(progress * 100)}%{eta !== null ? `・残り約 ${Math.ceil(eta)} 秒` : ""}（画面を開いたままにしてください）
          </div>
          <button class="btn small" style={{ marginTop: 6 }} onClick={() => job.current?.cancel()}>
            中止
          </button>
        </div>
      )}
      {phase === "error" && message && <p class="small">{message}</p>}
      {phase === "done" && result && (
        <div style={{ marginTop: 8 }}>
          {timeMs !== null && <div class="bigtime">{formatTime(timeMs)}</div>}
          <div class="muted small" style={{ textAlign: "center" }}>
            {moves.length} 手{timeMs ? `・${(moves.length / Math.max(0.001, timeMs / 1000)).toFixed(2)} TPS` : ""}
            {moves.some((m) => m.inferred) ? `・見えなかった手 ${moves.filter((m) => m.inferred).length}（?）` : ""}
          </div>
          {message && <p class="small">{message}</p>}
          <div class="scramble video-moves" style={{ marginTop: 6 }}>
            {moves.map((m, i) => (
              <span key={i} class={`mv ${m.inferred ? "inferred" : ""}`}>
                {MOVE_NAMES[m.move]}
                {m.inferred ? "?" : ""}
              </span>
            ))}
          </div>
          <div class="muted small">キューブ固定（センターの色）の表記・最初の手の回し始め 〜 最後の手の回し終わり</div>
        </div>
      )}
    </div>
  );
}

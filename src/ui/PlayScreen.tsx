// プレイ画面: 上にタイム、左に記録（ベスト・ao5・ao12・直近のタイム）、真ん中にカメラ（右上に 3D キューブ）、
// 下にスクランブル（回す前）か回した手（回した後）。タイマーとフリー（タイマーなしで回す）を上で切り替える
import { useEffect, useRef } from "preact/hooks";
import { controller } from "../app/controller";
import { settingsStore } from "../app/settings";
import { averageOf, effectiveTime, formatTime } from "../app/storage";
import { useStore } from "../app/store";
import { cancelTimer, inspectionTick, newScramble, stopManually, timerStore } from "../app/timer";
import { MOVE_NAMES, relativeMove, rotateOrientation } from "../cube/model";
import { mergeQuickRepeats, simplifyMoves } from "../track/merge";
import { CameraView } from "./CameraView";
import { Cube3D } from "./Cube3D";
import { SolutionGuide, StartCard } from "./playParts";
import { moveLabel, viewOrient } from "./notation";
import { ScanPanel } from "./ScanPanel";
import { AnalysisBadge, PenaltyRow, openSolve, useTicker } from "./solveUi";

// ---- 上: タイム ----

function ModeSwitch() {
  const panel = useStore(controller.store, (s) => s.panel);
  const busy = useStore(timerStore, (t) => t.phase !== "idle" && t.phase !== "done");
  return (
    <div class="mode-switch" role="tablist" aria-label="モード">
      {(["timer", "free"] as const).map((p) => (
        <button key={p} role="tab" aria-selected={panel === p} disabled={busy && panel !== p} onClick={() => controller.store.set({ panel: p })}>
          {p === "timer" ? "タイマー" : "フリー"}
        </button>
      ))}
    </div>
  );
}

// 認識の様子（カメラの fps・追跡の状態・精密解析の遅れ）を小さな点で
function StatusDot() {
  const s = useStore(controller.store, (x) => ({ camera: x.camera, fps: x.stats.camFps, proc: x.stats.procFps, status: x.track?.status, cube: !!x.cube, demo: x.demo, analysis: x.analysis }));
  const level = s.camera !== "on" ? "" : s.cube && s.status === "lost" ? "bad" : s.cube && s.status === "uncertain" ? "warn" : "ok";
  const text = s.camera !== "on" ? "カメラ停止" : `${s.demo ? "デモ・" : ""}${s.fps}fps・認識 ${s.proc}fps${s.analysis ? `・解析 ${s.analysis.behindMs < 500 ? "追従" : `${(s.analysis.behindMs / 1000).toFixed(1)}秒遅れ`}` : ""}`;
  return (
    <span class={`status-dot ${level}`} title={text}>
      <span class="dot" />
      <span class="txt">{text}</span>
    </span>
  );
}

function TimerTop() {
  const t = useStore(timerStore, (s) => s);
  const inspection = useStore(settingsStore, (s) => s.inspection);
  const now = useTicker(t.phase === "inspection" || t.phase === "solving");
  let main = "0.00";
  let sub = "";
  let cls = "";
  if (t.phase === "preparing") {
    cls = "idle";
    sub = "スクランブルを作っています…";
  } else if (t.phase === "scrambling") {
    cls = "idle";
    sub = t.recomputing ? "手順を計算しています…" : `スクランブル中・残り ${Math.max(0, t.guide.length - t.guideDone)} 手`;
  } else if (t.phase === "inspection") {
    main = inspection ? String(Math.max(0, 15 - Math.floor(inspectionTick(now) / 1000))) : "Ready";
    sub = "最初の 1 手でスタート";
    cls = "inspection";
  } else if (t.phase === "solving") {
    main = formatTime(now - t.startT);
    sub = `${t.liveMoves} 手`;
    cls = "solving";
  } else if (t.phase === "done" && t.result) {
    main = formatTime(effectiveTime(t.result));
    sub = t.result.penalty === "+2" ? "+2 込み" : "";
  }
  return (
    <div class={`time-main ${cls}`}>
      <div class="time-value">{main}</div>
      <div class="time-sub">
        {t.phase === "done" && t.result && <AnalysisBadge solve={t.result} progress={t.analysisProgress} />}
        {sub && <span>{sub}</span>}
      </div>
    </div>
  );
}

function FreeTop() {
  const track = useStore(controller.store, (s) => s.track);
  const base = useStore(controller.store, (s) => s.baseMoves);
  const moves = simplifyMoves(mergeQuickRepeats((track?.moves ?? []).slice(base, Math.max(base, track?.confirmed ?? 0))));
  const startT = moves[0]?.t ?? 0;
  const lastT = moves[moves.length - 1]?.t ?? 0;
  const running = moves.length > 0 && !track?.solved;
  const now = useTicker(running);
  const dur = running ? now - startT : lastT - startT;
  const tps = moves.length > 1 && lastT > startT ? (moves.length - 1) / ((lastT - startT) / 1000) : 0;
  return (
    <div class="time-main">
      <div class="time-value">{moves.length ? `${(dur / 1000).toFixed(1)}` : "0.0"}</div>
      <div class="time-sub">
        <span>{moves.length} 手</span>
        {tps > 0 && <span>{tps.toFixed(2)} TPS</span>}
        {track?.solved && moves.length > 0 && <span class="ok-text">完成</span>}
      </div>
    </div>
  );
}

function TopBar() {
  const panel = useStore(controller.store, (s) => s.panel);
  const result = useStore(timerStore, (t) => (t.phase === "done" ? t.result : null));
  return (
    <header class="play-top">
      <div class="play-top-row">
        <ModeSwitch />
        <StatusDot />
      </div>
      {panel === "timer" ? <TimerTop /> : <FreeTop />}
      {panel === "timer" && result && <PenaltyRow solve={result} />}
    </header>
  );
}

// ---- 左: 記録 ----

function SideColumn() {
  const solves = useStore(timerStore, (s) => s.solves);
  const valid = solves.filter((s) => Number.isFinite(effectiveTime(s)));
  const best = valid.length ? Math.min(...valid.map(effectiveTime)) : null;
  const bestId = valid.find((s) => effectiveTime(s) === best)?.id;
  return (
    <aside class="side-col" aria-label="記録">
      <dl class="side-stats">
        <div>
          <dt>best</dt>
          <dd>{formatTime(best)}</dd>
        </div>
        <div>
          <dt>ao5</dt>
          <dd>{formatTime(averageOf(solves, 5))}</dd>
        </div>
        <div>
          <dt>ao12</dt>
          <dd>{formatTime(averageOf(solves, 12))}</dd>
        </div>
      </dl>
      <ol class="side-times">
        {solves.slice(0, 50).map((s, i) => (
          <li key={s.id}>
            <button class={s.id === bestId ? "best" : ""} onClick={() => openSolve(s.id)} title={new Date(s.date).toLocaleString()}>
              <span class="n">{solves.length - i}</span>
              <span class="v">
                {formatTime(effectiveTime(s))}
                {s.penalty === "+2" ? "+" : ""}
              </span>
            </button>
          </li>
        ))}
        {!solves.length && <li class="empty">まだ記録がありません</li>}
      </ol>
    </aside>
  );
}

// ---- 真ん中: カメラと 3D キューブ ----

function TrackBadge() {
  const t = useStore(controller.store, (s) => ({ status: s.track?.status, faces: s.stats.faces, cube: !!s.cube, camera: s.camera }));
  if (t.camera !== "on" || !t.cube) return null;
  if (t.status === "lost") return <div class="cam-badge bad">見失いました。キューブを止めて 2 面を見せてください</div>;
  if (t.status === "uncertain") return <div class="cam-badge warn">確認中… 一瞬止めてください</div>;
  if (!t.faces) return <div class="cam-badge warn">キューブを映してください</div>;
  return null;
}

function CubeInset() {
  const cube = useStore(controller.store, (s) => s.cube);
  const track = useStore(controller.store, (s) => s.track);
  const settings = useStore(settingsStore, (s) => ({ view: s.cube3dView }));
  const mirror = useStore(controller.store, (s) => s.mirror);
  const demo = useStore(controller.store, (s) => s.demo);
  if (!cube) return null;
  // 見えているキューブと同じ状態にする: いまの見え方に一番合う仮説の手順（確定を待つと、その間 3D が見えているキューブとずれた）。
  // 足された手は回して見せ、解釈が変わったら回さずにその状態へ切り替える（Cube3D の live）。手順を追えずに見えている色に合わせて
  // 作り変えたら（track.base）、その場でその状態にする
  const moves = (track?.moves ?? []).map((m) => m.move);
  const shownOrient = track?.view?.orient ?? track?.orient ?? 0; // 表示だけの作り変えの間は、その状態の姿勢
  const orient = settings.view === "fixed" || !track ? null : settings.view === "user" ? rotateOrientation(shownOrient, "y", 2) : shownOrient;
  return (
    <div class="cube-inset">
      <Cube3D epoch={cube.epoch} setupMoves={cube.setupMoves} moves={moves} orient={orient} view={settings.view} mirror={settings.view === "camera" && mirror && !demo} colors={null} live base={track?.base ?? null} seen={track?.view ?? null} />
    </div>
  );
}

// ---- 下: スクランブル / 回した手 ----

function MoveStrip({ labels, empty }: { labels: { text: string; cls?: string }[]; empty: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollLeft = box.current.scrollWidth;
  }, [labels.length]);
  return (
    <div class="move-strip" ref={box}>
      {labels.length ? labels.map((l, i) => <span key={i} class={`mv ${l.cls ?? ""}`}>{l.text}</span>) : <span class="muted small">{empty}</span>}
    </div>
  );
}

// ライブで回した手（確かになった手だけ）
function LiveMoves({ from }: { from: number }) {
  const track = useStore(controller.store, (s) => s.track);
  const settings = useStore(settingsStore, (s) => ({ notation: s.notation, viewpoint: s.viewpoint }));
  const moves = simplifyMoves(mergeQuickRepeats((track?.moves ?? []).slice(from, Math.max(from, track?.confirmed ?? 0))));
  return <MoveStrip labels={moves.map((m, i) => ({ text: moveLabel(m, settings), cls: i === moves.length - 1 ? "latest" : "" }))} empty="回した手がここに出ます" />;
}

function ScrambleGuide() {
  const t = useStore(timerStore, (s) => s);
  const orient = useStore(controller.store, (s) => s.track?.orient ?? 0);
  const settings = useStore(settingsStore, (s) => ({ notation: s.notation, viewpoint: s.viewpoint }));
  const label = (m: number) => (settings.notation === "relative" ? MOVE_NAMES[relativeMove(m, viewOrient(orient, settings))] : MOVE_NAMES[m]);
  const fix = t.guideFix;
  return (
    <div class="strip-block">
      <div class="strip-head">
        <span>スクランブル</span>
        <span class="muted small">{settings.notation === "relative" ? "今の持ち方での表記" : "白上・緑前"}</span>
        <span class="spacer" />
        <button class="btn small ghost" onClick={cancelTimer}>
          やめる
        </button>
      </div>
      {fix === null ? (
        <div class="fix-note">案内からずれました。キューブを案内の状態に戻してください</div>
      ) : fix.length > 0 ? (
        <div class="fix-note">
          ずれています。先にこれを回して戻してください:
          {fix.map((m, i) => (
            <span key={i} class={`mv fix ${i === 0 ? "next" : ""}`}>
              {label(m)}
            </span>
          ))}
        </div>
      ) : null}
      <div class="move-strip wrap">
        {t.guide.map((m, i) => {
          const state = i < t.guideDone ? "done" : i === t.guideDone && !fix?.length ? (t.guideHalf ? "next half" : "next") : "";
          return (
            <span key={i} class={`mv ${state}`} title={state.includes("half") ? "半分（90°）回しました。もう 90°" : undefined}>
              {label(m)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function TimerStrip() {
  const t = useStore(timerStore, (s) => s);
  const settings = useStore(settingsStore, (s) => ({ notation: s.notation }));
  if (t.phase === "scrambling") return <ScrambleGuide />;
  if (t.phase === "preparing") return <div class="strip-block muted">スクランブルを作っています…</div>;
  if (t.phase === "inspection")
    return (
      <div class="strip-block">
        <div class="strip-head">
          <span>スクランブル完了</span>
          <span class="spacer" />
          <button class="btn small ghost" onClick={cancelTimer}>
            やめる
          </button>
        </div>
        <p class="muted small" style={{ margin: 0 }}>
          最初の 1 手でタイマーが始まり、揃った瞬間に止まります。
        </p>
      </div>
    );
  if (t.phase === "solving")
    return (
      <div class="strip-block">
        <div class="strip-head">
          <span>回した手</span>
          <span class="spacer" />
          <button class="btn small" onClick={stopManually}>
            止める <span class="kbd">Space</span>
          </button>
        </div>
        <LiveMoves from={t.startIndex} />
      </div>
    );
  const r = t.phase === "done" ? t.result : null;
  return (
    <div class="strip-block">
      {r && (
        <>
          <div class="strip-head">
            <span>回した手</span>
            <span class="muted small">
              {r.moves.length} 手・{r.tps.toFixed(2)} TPS
            </span>
            <span class="spacer" />
            <button class="btn small ghost" onClick={() => openSolve(r.id)}>
              詳しく
            </button>
          </div>
          {r.analysis === "pending" ? (
            <div class="progress">
              <div style={{ width: `${Math.round(t.analysisProgress * 100)}%` }} />
            </div>
          ) : (
            <MoveStrip labels={r.moves.map((m) => ({ text: settings.notation === "relative" ? m.r : m.m, cls: m.inferred ? "inferred" : "" }))} empty="手順を読めませんでした" />
          )}
        </>
      )}
      <div class="btn-row">
        <button class="btn primary" onClick={() => newScramble()}>
          {r ? "次のソルブ" : "スクランブルを出す"}
        </button>
      </div>
      {t.message && <p class="muted small">{t.message}</p>}
    </div>
  );
}

function FreeStrip() {
  const base = useStore(controller.store, (s) => s.baseMoves);
  return (
    <div class="strip-block">
      <div class="strip-head">
        <span>回した手</span>
        <span class="spacer" />
        <button class="btn small ghost" onClick={() => controller.clearMoves()}>
          クリア
        </button>
        <button class="btn small ghost" onClick={() => controller.resetToSolved()}>
          完成にリセット
        </button>
        <button class="btn small ghost" onClick={() => controller.beginScan()}>
          再スキャン
        </button>
      </div>
      <LiveMoves from={base} />
      <div class="strip-guide">
        <SolutionGuide />
      </div>
    </div>
  );
}

function BottomStrip() {
  const app = useStore(controller.store, (s) => ({ scan: !!s.scan, cube: !!s.cube, panel: s.panel }));
  return (
    <section class="play-strip">
      {app.scan ? <ScanPanel /> : !app.cube ? <StartCard /> : app.panel === "timer" ? <TimerStrip /> : <FreeStrip />}
    </section>
  );
}

export function PlayScreen() {
  // Space で手動停止（タイマーの計測中）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && timerStore.get().phase === "solving") {
        e.preventDefault();
        stopManually();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div class="play">
      <TopBar />
      <div class="play-mid">
        <SideColumn />
        <div class="cam-box">
          <CameraView />
          <CubeInset />
          <TrackBadge />
        </div>
      </div>
      <BottomStrip />
    </div>
  );
}

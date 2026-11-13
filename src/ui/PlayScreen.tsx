// プレイ画面: カメラを画面いっぱいに映し、その上にタイム・記録・回した手・3D キューブを重ねる（画面録画がそのまま縦動画になる）。
// 上にタイマー / フリーの切り替えと認識の様子、タイム、記録（best・ao5・ao12・直近のタイム）。下に回す前はスクランブル、回した後は
// 回した手、右下に 3D キューブ。タイマーの計測中は、タイムとカメラ・回した手だけを残して他を隠す（`focus`）
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
import { shareSolve } from "./shareCard";
import { AnalysisBadge, PenaltyRow, bestGain, openSolve, useTicker } from "./solveUi";

// タイマーで計測している間（下のバー・切り替え・記録を隠す）
export const useFocus = () => {
  const panel = useStore(controller.store, (s) => s.panel);
  const solving = useStore(timerStore, (t) => t.phase === "solving");
  return panel === "timer" && solving;
};

// ---- 上: タイム ----

function ModeSwitch() {
  const panel = useStore(controller.store, (s) => s.panel);
  const busy = useStore(timerStore, (t) => t.phase !== "idle" && t.phase !== "done");
  return (
    <div class="mode-switch glass" role="tablist" aria-label="モード">
      {(["timer", "free"] as const).map((p) => (
        <button key={p} role="tab" aria-selected={panel === p} disabled={busy && panel !== p} onClick={() => controller.store.set({ panel: p })}>
          {p === "timer" ? "タイマー" : "フリー"}
        </button>
      ))}
    </div>
  );
}

// 認識の様子（カメラの fps・追跡の状態・精密解析の遅れ）
function StatusDot() {
  const s = useStore(controller.store, (x) => ({ camera: x.camera, fps: x.stats.camFps, proc: x.stats.procFps, status: x.track?.status, cube: !!x.cube, demo: x.demo, analysis: x.analysis }));
  const level = s.camera !== "on" ? "" : s.cube && s.status === "lost" ? "bad" : s.cube && s.status === "uncertain" ? "warn" : "ok";
  const text = s.camera !== "on" ? "カメラ停止" : `${s.demo ? "デモ・" : ""}${s.fps}fps・認識 ${s.proc}fps${s.analysis ? `・解析 ${s.analysis.behindMs < 500 ? "追従" : `${(s.analysis.behindMs / 1000).toFixed(1)}秒遅れ`}` : ""}`;
  return (
    <span class={`status-dot glass ${level}`} title={text}>
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
  let label = "";
  let cls = "";
  if (t.phase === "preparing") {
    cls = "idle";
    label = "スクランブルを作っています…";
  } else if (t.phase === "scrambling") {
    cls = "idle";
    label = t.recomputing ? "手順を計算しています…" : `スクランブル・残り ${Math.max(0, t.guide.length - t.guideDone)} 手`;
  } else if (t.phase === "inspection") {
    main = inspection ? String(Math.max(0, 15 - Math.floor(inspectionTick(now) / 1000))) : "Ready";
    label = "インスペクション・最初の 1 手でスタート";
    cls = "inspection";
  } else if (t.phase === "solving") {
    main = formatTime(now - t.startT);
    label = `計測中・${t.liveMoves} 手`;
    cls = "solving";
  } else if (t.phase === "done" && t.result) {
    main = formatTime(effectiveTime(t.result));
    label = `${t.result.moves.length} 手・${t.result.tps.toFixed(2)} TPS${t.result.penalty === "+2" ? "・+2 込み" : ""}`;
    cls = "done";
  }
  const r = t.phase === "done" ? t.result : null;
  const gain = r ? bestGain(t.solves, r) : null;
  return (
    <div class={`time-main ${cls}`}>
      <div class="time-label">{label}</div>
      <div class="time-value" key={r ? `done-${r.id}` : "live"}>
        {main}
      </div>
      {r && (
        <div class="time-badges">
          {gain !== null && (
            <span class="pb-badge">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z" />
              </svg>
              自己ベスト −{(gain / 1000).toFixed(2)}
            </span>
          )}
          <AnalysisBadge solve={r} progress={t.analysisProgress} />
        </div>
      )}
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
  const solved = !!track?.solved && moves.length > 0;
  return (
    <div class={`time-main ${moves.length ? "" : "idle"}`}>
      <div class="time-label">
        フリー・{moves.length} 手{tps > 0 ? `・${tps.toFixed(2)} TPS` : ""}
        {solved && <span class="ok-text">・完成</span>}
      </div>
      <div class="time-value" key={solved ? `solved-${moves.length}` : "live"}>
        {moves.length ? `${(dur / 1000).toFixed(1)}` : "0.0"}
      </div>
    </div>
  );
}

// 記録: best・ao5・ao12 と直近のタイム（押すとその記録の詳しい画面）
function Records() {
  const solves = useStore(timerStore, (s) => s.solves);
  const valid = solves.filter((s) => Number.isFinite(effectiveTime(s)));
  const best = valid.length ? Math.min(...valid.map(effectiveTime)) : null;
  const bestId = valid.find((s) => effectiveTime(s) === best)?.id;
  return (
    <div class="records chrome">
      <dl class="rec-stats">
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
      <ol class="rec-times" aria-label="直近のタイム">
        {solves.slice(0, 50).map((s, i) => (
          <li key={s.id}>
            <button class={s.id === bestId ? "best" : ""} onClick={() => openSolve(s.id)} title={`${solves.length - i} 回目・${new Date(s.date).toLocaleString()}`}>
              {formatTime(effectiveTime(s))}
              {s.penalty === "+2" ? "+" : ""}
            </button>
          </li>
        ))}
        {!solves.length && <li class="empty">まだ記録がありません</li>}
      </ol>
    </div>
  );
}

function TopBar() {
  const panel = useStore(controller.store, (s) => s.panel);
  return (
    <header class="stage-top">
      <div class="stage-bar chrome">
        <ModeSwitch />
        <StatusDot />
      </div>
      <div class="stage-time">
        {panel === "timer" ? <TimerTop /> : <FreeTop />}
        {panel === "timer" && <Records />}
      </div>
    </header>
  );
}

// ---- カメラの上: 追跡の様子 ----

function TrackBadge() {
  const t = useStore(controller.store, (s) => ({ status: s.track?.status, faces: s.stats.faces, cube: !!s.cube, camera: s.camera }));
  if (t.camera !== "on" || !t.cube) return null;
  if (t.status === "lost") return <div class="cam-badge glass bad">見失いました。キューブを止めて 2 面を見せてください</div>;
  if (t.status === "uncertain") return <div class="cam-badge glass warn">確認中… 一瞬止めてください</div>;
  if (!t.faces) return <div class="cam-badge glass warn">キューブを映してください</div>;
  return null;
}

// ---- 右下: 3D キューブ（完成したら光の輪と 6 色の欠片） ----

const BURST_COLORS = ["#f5f5f7", "#1fb35f", "#e8323e", "#ff7b1c", "#2a66e0", "#ffd60a"];

function Celebrate() {
  return (
    <div class="celebrate" aria-hidden="true">
      <span class="ring" />
      {Array.from({ length: 14 }, (_, i) => (
        <span key={i} class="spark" style={{ transform: `rotate(${(i * 360) / 14 + (i % 2) * 9}deg)` }}>
          <i class={i % 2 ? "far" : "near"} style={{ background: BURST_COLORS[i % 6], animationDelay: `${0.15 + (i % 3) * 0.05}s` }} />
        </span>
      ))}
    </div>
  );
}

function CubeInset() {
  const cube = useStore(controller.store, (s) => s.cube);
  const track = useStore(controller.store, (s) => s.track);
  const settings = useStore(settingsStore, (s) => ({ view: s.cube3dView }));
  const mirror = useStore(controller.store, (s) => s.mirror);
  const demo = useStore(controller.store, (s) => s.demo);
  const panel = useStore(controller.store, (s) => s.panel);
  const doneId = useStore(timerStore, (t) => (t.phase === "done" ? (t.result?.id ?? null) : null));
  const base = useStore(controller.store, (s) => s.baseMoves);
  if (!cube) return null;
  // 見えているキューブと同じ状態にする: いまの見え方に一番合う仮説の手順（確定を待つと、その間 3D が見えているキューブとずれた）。
  // 足された手は回して見せ、解釈が変わったら回さずにその状態へ切り替える（Cube3D の live）。手順を追えずに見えている色に合わせて
  // 作り変えたら（track.base）、その場でその状態にする
  const moves = (track?.moves ?? []).map((m) => m.move);
  const shownOrient = track?.view?.orient ?? track?.orient ?? 0; // 表示だけの作り変えの間は、その状態の姿勢
  const orient = settings.view === "fixed" || !track ? null : settings.view === "user" ? rotateOrientation(shownOrient, "y", 2) : shownOrient;
  // 完成の演出: タイマーは止まったとき、フリーは回した後に揃ったとき
  const freeSolved = panel === "free" && !!track?.solved && (track?.confirmed ?? 0) > base;
  const party = panel === "timer" ? doneId : freeSolved ? `free-${track?.confirmed}` : null;
  return (
    <div class={`cube-inset${party ? " party" : ""}`}>
      {party && <Celebrate key={party} />}
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
      {labels.length ? labels.map((l, i) => <span key={i} class={`mv ${l.cls ?? ""}`}>{l.text}</span>) : <span class="strip-empty">{empty}</span>}
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
        <span class="strip-note">{settings.notation === "relative" ? "今の持ち方での表記" : "白上・緑前"}</span>
        <span class="spacer" />
        <button class="pill" onClick={cancelTimer}>
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
      <div class="move-strip wrap scramble-moves">
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

function DoneStrip() {
  const t = useStore(timerStore, (s) => s);
  const settings = useStore(settingsStore, (s) => ({ notation: s.notation }));
  const r = t.phase === "done" ? t.result : null;
  return (
    <div class="strip-block">
      {r && (
        <>
          {r.analysis === "pending" ? (
            <div class="progress glass-progress" aria-label="解析の進み具合">
              <div style={{ width: `${Math.round(t.analysisProgress * 100)}%` }} />
            </div>
          ) : (
            <MoveStrip labels={r.moves.map((m) => ({ text: settings.notation === "relative" ? m.r : m.m, cls: m.inferred ? "inferred" : "" }))} empty="手順を読めませんでした" />
          )}
          <div class="done-actions">
            <PenaltyRow solve={r} />
            <button class="seg share" onClick={() => shareSolve(r, t.solves)}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 15V3M7 8l5-5 5 5M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6" />
              </svg>
              共有
            </button>
          </div>
        </>
      )}
      <div class="next-row">
        <button class="btn primary" onClick={() => newScramble()}>
          {r ? "次のソルブ" : "スクランブルを出す"}
        </button>
        {r && (
          <button class="pill" onClick={() => openSolve(r.id)}>
            詳しく
          </button>
        )}
      </div>
      {t.message && <p class="strip-note">{t.message}</p>}
    </div>
  );
}

function TimerStrip() {
  const phase = useStore(timerStore, (s) => s.phase);
  const startIndex = useStore(timerStore, (s) => s.startIndex);
  if (phase === "scrambling") return <ScrambleGuide />;
  if (phase === "preparing") return <div class="strip-block strip-note">スクランブルを作っています…</div>;
  if (phase === "inspection")
    return (
      <div class="strip-block">
        <div class="strip-head">
          <span class="rise">スクランブル完了・準備ができたら回してください</span>
          <span class="spacer" />
          <button class="pill" onClick={cancelTimer}>
            やめる
          </button>
        </div>
        <p class="strip-note">最初の 1 手でタイマーが始まり、揃った瞬間に止まります。</p>
      </div>
    );
  if (phase === "solving")
    return (
      <div class="strip-block">
        <LiveMoves from={startIndex} />
        <div class="strip-head">
          <span class="spacer" />
          <button class="pill" onClick={stopManually}>
            止める <span class="kbd">Space</span>
          </button>
        </div>
      </div>
    );
  return <DoneStrip />;
}

function FreeStrip() {
  const base = useStore(controller.store, (s) => s.baseMoves);
  return (
    <div class="strip-block">
      <LiveMoves from={base} />
      <div class="strip-head wrap">
        <button class="pill" onClick={() => controller.clearMoves()}>
          クリア
        </button>
        <button class="pill" onClick={() => controller.resetToSolved()}>
          完成にリセット
        </button>
        <button class="pill" onClick={() => controller.beginScan()}>
          再スキャン
        </button>
      </div>
      <div class="strip-guide">
        <SolutionGuide />
      </div>
    </div>
  );
}

function BottomStrip() {
  const app = useStore(controller.store, (s) => ({ scan: !!s.scan, cube: !!s.cube, panel: s.panel }));
  // スキャン・始め方は文字が多いので、すりガラスの板に載せる
  const sheet = app.scan || !app.cube;
  return (
    <section class={`play-strip${sheet ? " sheet glass" : ""}`}>
      {app.scan ? <ScanPanel /> : !app.cube ? <StartCard /> : app.panel === "timer" ? <TimerStrip /> : <FreeStrip />}
    </section>
  );
}

export function PlayScreen() {
  const focus = useFocus();
  const scanning = useStore(controller.store, (s) => !!s.scan);
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
    <div class={`play stage${focus ? " focus" : ""}${scanning ? " scanning" : ""}`}>
      <div class="stage-cam">
        <CameraView />
      </div>
      <div class="stage-scrim top" aria-hidden="true" />
      <div class="stage-scrim bottom" aria-hidden="true" />
      <TopBar />
      <TrackBadge />
      <div class="stage-bottom">
        <BottomStrip />
        <CubeInset />
      </div>
    </div>
  );
}

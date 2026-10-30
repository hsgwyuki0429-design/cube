import { useEffect } from "preact/hooks";
import { controller, type Screen } from "../app/controller";
import { settingsStore } from "../app/settings";
import { useStore } from "../app/store";
import { CameraView } from "./CameraView";
import { Cube3D } from "./Cube3D";
import { FreePanel, StartCard } from "./FreePanel";
import { MoveList } from "./MoveList";
import { ArucoScreen } from "./ArucoScreen";
import { HelpPage } from "./HelpPage";
import { HistoryPage } from "./HistoryPage";
import { ScanPanel } from "./ScanPanel";
import { SettingsPage } from "./SettingsPage";
import { TimerPanel } from "./TimerPanel";
import { mergeQuickRepeats, simplifyMoves } from "../track/merge";
import { rotateOrientation } from "../cube/model";
import { moveLabel as labelOf } from "./notation";

function Logo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 2 29 9v14l-13 7L3 23V9z" fill="#1d2433" />
      <path d="M16 2 29 9 16 16 3 9z" fill="#f2f2f2" />
      <path d="M3 9l13 7v14L3 23z" fill="#00a651" />
      <path d="M29 9 16 16v14l13-7z" fill="#d0213a" />
      <path d="M9.5 5.5 22.5 12.5M22.5 5.5 9.5 12.5M3 16l13 7M29 16l-13 7M9.5 12.5v14M22.5 12.5v14" stroke="#10131a" stroke-width="1.2" />
    </svg>
  );
}

function StatusChips() {
  const s = useStore(controller.store, (x) => ({ camera: x.camera, vision: x.vision, stats: x.stats, status: x.track?.status, cube: !!x.cube, demo: x.demo, analysis: x.analysis }));
  const trackChip = !s.cube ? null : s.status === "lost" ? ["bad", "見失い"] : s.status === "uncertain" ? ["warn", "確認中"] : ["ok", "追跡中"];
  return (
    <div class="chips">
      {s.demo && <span class="chip warn">デモ</span>}
      <span class={`chip ${s.camera === "on" ? "ok" : s.camera === "error" ? "bad" : ""}`}>
        <span class="dot" />
        カメラ {s.camera === "on" ? `${s.stats.camFps}fps` : s.camera === "error" ? "エラー" : "停止"}
      </span>
      <span class={`chip ${s.vision === "ready" ? "ok" : s.vision === "loading" ? "" : "warn"}`}>
        <span class="dot" />
        認識 {s.vision === "loading" ? "読込中" : s.vision === "error" ? "使えません" : `${s.stats.procFps}fps・${s.stats.procMs.toFixed(0)}ms`}
      </span>
      {trackChip && (
        <span class={`chip ${trackChip[0]}`}>
          <span class="dot" />
          {trackChip[1]}
        </span>
      )}
      {s.analysis && (
        <span class={`chip ${s.analysis.behindMs < 2000 ? "ok" : "warn"}`} title="録画を重い設定で解き直し、追跡に反映しています（遅れ）">
          <span class="dot" />
          精密解析 {s.analysis.behindMs < 500 ? "追いついています" : `${(s.analysis.behindMs / 1000).toFixed(1)}秒遅れ`}
        </span>
      )}
    </div>
  );
}

function Main() {
  const app = useStore(controller.store, (s) => ({ panel: s.panel, scan: !!s.scan, cube: s.cube, demo: s.demo }));
  const track = useStore(controller.store, (s) => s.track);
  const base = useStore(controller.store, (s) => s.baseMoves);
  const settings = useStore(settingsStore, (s) => ({ view: s.cube3dView, mirror: s.mirror }));
  const moves = track?.moves.map((m) => m.move) ?? [];
  // 連続的な姿勢が来ないときの、離散的な姿勢での表示
  const orient = settings.view === "fixed" || !track ? null : settings.view === "user" ? rotateOrientation(track.orient, "y", 2) : track.orient;

  return (
    <main class="workspace">
      <section class="stage">
        <div class="card camera-card">
          <CameraView />
        </div>
        <div class="card cube-card">
          <div class="cube-wrap">
            {app.cube ? (
              <Cube3D
                epoch={app.cube.epoch}
                setupMoves={app.cube.setupMoves}
                moves={moves}
                orient={orient}
                view={settings.view}
                mirror={settings.view === "camera" && settings.mirror && !app.demo}
                colors={null}
              />
            ) : (
              <div class="cube3d">
                <div class="loading">追跡を始めると、ここに手元のキューブが再現されます</div>
              </div>
            )}
            <RecentMoves />
          </div>
        </div>
        {app.cube && (
          <div class="card log-card">
            <div class="card-head">
              手順ログ<span class="spacer" />
              <span class="muted small">薄い手 = 未確定・点線 = 後から推定</span>
            </div>
            <div class="card-body">
              <MoveList moves={track?.moves ?? []} confirmed={track?.confirmed ?? 0} offset={base} />
            </div>
          </div>
        )}
      </section>
      <aside class="card">
        {!app.scan && (
          <div class="tabs" role="tablist">
            <button role="tab" aria-selected={app.panel === "free"} onClick={() => controller.store.set({ panel: "free" })}>
              フリー
            </button>
            <button role="tab" aria-selected={app.panel === "timer"} onClick={() => controller.store.set({ panel: "timer" })}>
              タイマー
            </button>
          </div>
        )}
        <div class="card-body">
          {app.scan ? <ScanPanel /> : !app.cube ? <StartCard /> : app.panel === "free" ? <FreePanel /> : <TimerPanel />}
          {app.demo && (
            <div class="section">
              <div class="status-banner warn small">
                デモ中: 合成カメラの映像を、本物のカメラと同じ認識処理で追跡しています。
                <div style={{ marginTop: 6 }}>
                  <button class="btn small" onClick={() => controller.startCamera()}>
                    本物のカメラに切り替える
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </aside>
    </main>
  );
}

function RecentMoves() {
  const track = useStore(controller.store, (s) => s.track);
  const base = useStore(controller.store, (s) => s.baseMoves);
  const settings = useStore(settingsStore, (s) => ({ notation: s.notation, viewpoint: s.viewpoint }));
  const merged = simplifyMoves(mergeQuickRepeats((track?.moves ?? []).slice(base)));
  const count = merged.length;
  const last = merged.slice(-7);
  if (!last.length) return null;
  return (
    <div class="recent">
      <div class="latest">{labelOf(last[last.length - 1], settings)}</div>
      <div class="trail">
        {last
          .slice(0, -1)
          .reverse()
          .map((m, i) => (
            <span key={i} style={{ opacity: 1 - i * 0.14 }}>
              {labelOf(m, settings)}
            </span>
          ))}
      </div>
      <div class="count">{Math.max(0, count)} 手</div>
    </div>
  );
}

export function App() {
  const screen = useStore(controller.store, (s) => s.screen);
  const toast = useStore(controller.store, (s) => s.toast);
  // ArUco の画面は URL（#aruco）にも出す: 再読み込みで同じ画面に戻り、他の画面に移れば外す
  useEffect(() => {
    const path = location.pathname.replace(/aruco\.html$/, "");
    const want = screen === "aruco" ? `${path}#aruco` : path;
    if (location.pathname + location.hash !== want) history.replaceState(null, "", want + location.search);
  }, [screen]);
  const nav: [Screen, string][] = [
    ["main", "メイン"],
    ["history", "履歴"],
    ["settings", "設定"],
    ["aruco", "ArUco"],
    ["help", "使い方"],
  ];
  return (
    <>
      <header class="topbar">
        <div class="brand">
          <Logo />
          <span>CubeVision</span>
        </div>
        <StatusChips />
        <nav class="nav">
          {nav.map(([id, label]) => (
            <button key={id} aria-current={screen === id ? "page" : undefined} onClick={() => controller.store.set({ screen: id })}>
              {label}
            </button>
          ))}
        </nav>
      </header>
      <div style={{ display: screen === "main" ? "contents" : "none" }}>
        <Main />
      </div>
      {screen === "history" && <HistoryPage />}
      {screen === "settings" && <SettingsPage />}
      {screen === "help" && <HelpPage />}
      <ArucoScreen active={screen === "aruco"} />
      {toast && <div class="toast">{toast}</div>}
    </>
  );
}

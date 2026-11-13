// 画面の骨組み: 浮いたすりガラスの下のバー（広い画面・横持ちでは左に縦に並べる）で プレイ / データ / 設定 を切り替える。
// 解析の画面（スロー動画から記録・動画を解析・ArUco）はバーから外した（2026-11）。開発用に #aruco・aruco.html・store の screen: "analyze"
// からは開ける（scripts/video-e2e.mjs）。プレイと解析は他の画面に移っても残す（計測・解析を続け、結果も消えない）
import { useEffect } from "preact/hooks";
import { controller, type Screen } from "../app/controller";
import { useStore } from "../app/store";
import { AnalyzeScreen } from "./AnalyzeScreen";
import { DataScreen } from "./DataScreen";
import { DataIcon, PlayIcon, SettingsIcon } from "./icons";
import { PlayScreen, useFocus } from "./PlayScreen";
import { SettingsPage } from "./SettingsPage";
import { SolveDetail } from "./SolveDetail";

const NAV: { id: Screen; label: string; icon: () => preact.JSX.Element }[] = [
  { id: "play", label: "プレイ", icon: PlayIcon },
  { id: "data", label: "データ", icon: DataIcon },
  { id: "settings", label: "設定", icon: SettingsIcon },
];

export function App() {
  const screen = useStore(controller.store, (s) => s.screen);
  const tab = useStore(controller.store, (s) => s.analyzeTab);
  const toast = useStore(controller.store, (s) => s.toast);
  // ArUco の画面は URL（#aruco）にも出す: 再読み込みで同じ画面に戻り、他の画面に移れば外す
  useEffect(() => {
    const path = location.pathname.replace(/aruco\.html$/, "");
    const want = screen === "analyze" && tab === "aruco" ? `${path}#aruco` : path;
    if (location.pathname + location.hash !== want) history.replaceState(null, "", want + location.search);
  }, [screen, tab]);
  const current = screen === "solve" ? "data" : screen;
  // タイマーの計測中は下のバーを隠す（プレイ画面の focus）
  const focus = useFocus() && screen === "play";
  return (
    <div class={`shell${focus ? " focus" : ""}`} data-screen={screen}>
      <nav class="appnav" aria-label="画面" aria-hidden={focus || undefined}>
        {NAV.map(({ id, label, icon: Icon }) => (
          <button key={id} aria-label={label} tabIndex={focus ? -1 : undefined} aria-current={current === id ? "page" : undefined} onClick={() => controller.store.set({ screen: id })}>
            <Icon />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <main class="screen">
        <div class="screen-play" style={{ display: screen === "play" ? undefined : "none" }}>
          <PlayScreen />
        </div>
        {screen === "data" && <DataScreen />}
        {screen === "solve" && <SolveDetail />}
        <AnalyzeScreen active={screen === "analyze"} />
        {screen === "settings" && <SettingsPage />}
      </main>
      {toast && <div class="toast">{toast}</div>}
    </div>
  );
}

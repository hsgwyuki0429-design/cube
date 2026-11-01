// 解析の画面: スロー撮影の動画から記録する（タイマー）・揃った状態から回した動画を解析する（フリー）・ArUco の画面
// （動画から手順を推定するキューブモードと、検出率を出すテストモード）。他の画面に移っても残す（解析を続け、結果も消えない）
import { useEffect, useState } from "preact/hooks";
import { controller, type AnalyzeTab } from "../app/controller";
import { useStore } from "../app/store";
import { ArucoScreen } from "./ArucoScreen";
import { VideoAnalysis } from "./VideoAnalysis";

const TABS: [AnalyzeTab, string][] = [
  ["timer-video", "スロー動画から記録"],
  ["free-video", "動画を解析"],
  ["aruco", "ArUco"],
];

export function AnalyzeScreen({ active }: { active: boolean }) {
  const tab = useStore(controller.store, (s) => s.analyzeTab);
  // 各タブは初めて開いたときに作り、その後は残す（解析を続け、結果も消えない。起動時にスクランブルを作らない）
  const [opened, setOpened] = useState<Set<AnalyzeTab>>(() => new Set());
  useEffect(() => {
    if (active && !opened.has(tab)) setOpened(new Set([...opened, tab]));
  }, [active, tab]);
  return (
    <div class="analyze" style={{ display: active ? undefined : "none" }}>
      <div class="page-tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => controller.store.set({ analyzeTab: id })}>
            {label}
          </button>
        ))}
      </div>
      {opened.has("timer-video") && (
        <div class="page" style={{ display: tab === "timer-video" ? undefined : "none" }}>
          <VideoAnalysis mode="timer" />
        </div>
      )}
      {opened.has("free-video") && (
        <div class="page" style={{ display: tab === "free-video" ? undefined : "none" }}>
          <VideoAnalysis mode="free" />
        </div>
      )}
      <ArucoScreen active={active && tab === "aruco"} />
    </div>
  );
}

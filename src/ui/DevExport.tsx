// 止めた後の画面の開発用の「書き出す」と、最後のソルブの様子（文字だけ）。?debug か設定の「開発用の書き出し」がオンのときだけ出す。
// 精密解析が終わるまでは押せない（「解析中」）。書き出すのは src/ui/bundleExport.ts、要約は src/app/solveSummary.ts
import { useEffect } from "preact/hooks";
import { controller } from "../app/controller";
import { settingsStore } from "../app/settings";
import { summaryLines } from "../app/solveSummary";
import { useStore } from "../app/store";
import { timerStore } from "../app/timer";
import { bundleStore, devExportOn, exportBundle, prepareBundle, summaryOf } from "./bundleExport";

export function DevExport() {
  const on = useStore(settingsStore, (s) => devExportOn(s));
  const t = useStore(timerStore, (s) => ({ id: s.phase === "done" ? (s.result?.id ?? null) : null, analysis: s.result?.analysis }));
  useStore(bundleStore, (s) => s.rev);
  const cap = controller.lastRecording;
  const mine = !!cap && !!t.id && cap.live?.solveId === t.id;
  const settled = mine && (!!cap.result || !!cap.error);
  // 後からオンにした: 材料をいま作る
  useEffect(() => {
    if (on && settled && cap && !cap.bundle) void prepareBundle(cap);
  }, [on, settled, cap]);
  if (!on || !t.id) return null;
  const ready = mine && !!cap.bundle;
  const label = !mine ? (t.analysis === "pending" ? "解析中" : "録画なし") : !settled ? "解析中" : !ready ? "準備中" : "書き出す";
  const lines = ready ? summaryLines(summaryOf(cap!)) : [];
  return (
    <div class="dev-export">
      <div class="dev-export-head">
        <span>開発用</span>
        <button class="pill" disabled={!ready} onClick={() => void exportBundle()}>
          {label}
        </button>
      </div>
      {lines.length > 0 && (
        <pre class="dev-summary" aria-label="最後のソルブの様子">
          {lines.join("\n")}
        </pre>
      )}
    </div>
  );
}

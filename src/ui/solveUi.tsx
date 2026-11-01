// 記録（ソルブ）まわりの共通の部品: 解析の印・ペナルティと削除のボタン・毎フレームの時計
import { useEffect, useState } from "preact/hooks";
import { controller } from "../app/controller";
import { type Solve, formatTime } from "../app/storage";
import { deleteSolve, setPenalty } from "../app/timer";

export function useTicker(active: boolean): number {
  const [now, setNow] = useState(performance.now());
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const loop = () => {
      setNow(performance.now());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return now;
}

export function AnalysisBadge({ solve, progress }: { solve: Solve; progress?: number }) {
  if (solve.video)
    return (
      <span class="chip analysis done" title="動画ファイル（スロー撮影など）を読み込んで、全フレームを解析した記録です">
        動画から
      </span>
    );
  if (solve.analysis === "pending")
    return (
      <span class="chip analysis pending" title="録画を1フレームずつ解析しています。終わるとタイムと手順が確定します">
        解析中{progress !== undefined && progress > 0 ? ` ${Math.round(progress * 100)}%` : "…"}
      </span>
    );
  if (solve.analysis === "done")
    return (
      <span class="chip analysis done" title={solve.provisionalMs !== undefined ? `速報値 ${formatTime(solve.provisionalMs)}` : undefined}>
        確定
      </span>
    );
  if (solve.analysis === "failed")
    return (
      <span class="chip analysis failed" title="録画から完成までをたどれなかったため、リアルタイムの結果のままです">
        速報値
      </span>
    );
  return null;
}

// ペナルティ（なし / +2 / DNF）と削除。削除だけは確かめてから。full: 「なし」も出す（詳しい画面）
export function PenaltyRow({ solve, full = false, onDeleted }: { solve: Solve; full?: boolean; onDeleted?: () => void }) {
  const set = (p: Solve["penalty"]) => setPenalty(solve.id, solve.penalty === p && !full ? "" : p);
  const remove = () => {
    if (!confirm("この記録を削除しますか？")) return;
    deleteSolve(solve.id);
    onDeleted?.();
    controller.toast("記録を削除しました");
  };
  return (
    <div class={`penalty-row${full ? " full" : ""}`}>
      {full && (
        <button class="seg" aria-pressed={solve.penalty === ""} onClick={() => set("")}>
          ペナルティなし
        </button>
      )}
      <button class="seg" aria-pressed={solve.penalty === "+2"} onClick={() => set("+2")}>
        +2
      </button>
      <button class="seg" aria-pressed={solve.penalty === "DNF"} onClick={() => set("DNF")}>
        DNF
      </button>
      <button class="seg danger" onClick={remove}>
        削除
      </button>
    </div>
  );
}

// 記録の詳しい画面を開く
export const openSolve = (id: string) => controller.store.set({ screen: "solve", solveId: id });

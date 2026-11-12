// データ画面: 上にグラフ 2 つ（それぞれ中身を選べる）、下に履歴（押すとその記録の詳しい画面）。書き出し・読み込みも
import { useState } from "preact/hooks";
import { type Solve, averageOf, effectiveTime, formatTime } from "../app/storage";
import { useStore } from "../app/store";
import { downloadText } from "../lib/util";
import { replaceSolves, timerStore } from "../app/timer";
import { CHART_KINDS, Chart, type ChartKind } from "./charts";
import { AnalysisBadge, openSolve } from "./solveUi";

// 選んだグラフは端末に覚えておく（読めなくても既定で動く）
function useChartKind(slot: number, fallback: ChartKind): [ChartKind, (k: ChartKind) => void] {
  const key = `cubevision.chart${slot}`;
  const [kind, setKind] = useState<ChartKind>(() => {
    try {
      const v = localStorage.getItem(key) as ChartKind | null;
      return v && CHART_KINDS.some(([k]) => k === v) ? v : fallback;
    } catch {
      return fallback;
    }
  });
  const set = (k: ChartKind) => {
    setKind(k);
    try {
      localStorage.setItem(key, k);
    } catch {
      // 覚えられなくても表示はできる
    }
  };
  return [kind, set];
}

function ChartCard({ slot, fallback, solves }: { slot: number; fallback: ChartKind; solves: Solve[] }) {
  const [kind, setKind] = useChartKind(slot, fallback);
  return (
    <section class="card chart-card">
      <select class="chart-select" value={kind} aria-label={`グラフ ${slot}`} onChange={(e) => setKind((e.target as HTMLSelectElement).value as ChartKind)}>
        {CHART_KINDS.map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </select>
      <Chart kind={kind} solves={solves} />
    </section>
  );
}

export function DataScreen() {
  const solves = useStore(timerStore, (s) => s.solves);
  const valid = solves.filter((s) => Number.isFinite(effectiveTime(s)));
  const best = valid.length ? Math.min(...valid.map(effectiveTime)) : null;
  const mean = valid.length ? valid.reduce((a, s) => a + effectiveTime(s), 0) / valid.length : null;

  const importJson = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text()) as Solve[];
        if (!Array.isArray(data)) throw new Error();
        const merged = [...data, ...solves].filter((s, i, arr) => arr.findIndex((x) => x.id === s.id) === i).sort((a, b) => b.date - a.date);
        replaceSolves(merged);
      } catch {
        alert("読み込めませんでした（CubeVision で書き出した JSON を選んでください）");
      }
    };
    input.click();
  };
  const csv = () =>
    ["date,time_ms,penalty,moves,tps,scramble,solution", ...solves.map((s) => [new Date(s.date).toISOString(), Math.round(s.timeMs), s.penalty, s.moves.length, s.tps.toFixed(2), `"${s.scramble}"`, `"${s.moves.map((m) => m.r).join(" ")}"`].join(","))].join("\n");

  return (
    <div class="page data">
      <div class="chart-grid">
        <ChartCard slot={1} fallback="timeline" solves={solves} />
        <ChartCard slot={2} fallback="splits" solves={solves} />
      </div>
      <section class="card history-card">
        <div class="card-head">
          履歴
          <span class="spacer" />
          <span class="muted small">
            {solves.length} 回・best {formatTime(best)}・平均 {formatTime(mean)}・ao5 {formatTime(averageOf(solves, 5))}・ao12 {formatTime(averageOf(solves, 12))}
          </span>
        </div>
        {solves.length ? (
          <ul class="history-list">
            {solves.map((s, i) => (
              <li key={s.id}>
                <button onClick={() => openSolve(s.id)}>
                  <span class="n">{solves.length - i}</span>
                  <span class="t">
                    {formatTime(effectiveTime(s))}
                    {s.penalty === "+2" && <small> +2</small>}
                  </span>
                  <span class="m muted small">{s.moves.length ? `${s.moves.length} 手・${s.tps.toFixed(2)} TPS` : "手順なし"}</span>
                  <AnalysisBadge solve={s} />
                  <span class="d muted small">{new Date(s.date).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p class="muted card-body">まだ記録がありません。プレイ画面のタイマーで計測すると、ここにたまります。</p>
        )}
        <div class="btn-row card-body">
          <button class="btn small" onClick={() => downloadText("cubevision-solves.json", JSON.stringify(solves, null, 1), "application/json")} disabled={!solves.length}>
            JSON で書き出す
          </button>
          <button class="btn small" onClick={() => downloadText("cubevision-solves.csv", csv(), "text/csv")} disabled={!solves.length}>
            CSV で書き出す
          </button>
          <button class="btn small" onClick={importJson}>
            JSON を読み込む
          </button>
        </div>
      </section>
    </div>
  );
}

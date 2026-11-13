// データ画面: 上に成績（best・ao5・ao12・平均）、グラフ 2 つ（それぞれ中身を選べる）、下に履歴（押すとその記録の詳しい画面）。書き出し・読み込みも
import { useState } from "preact/hooks";
import { type Solve, averageOf, effectiveTime, formatTime } from "../app/storage";
import { useStore } from "../app/store";
import { downloadText } from "../lib/util";
import { replaceSolves, timerStore } from "../app/timer";
import { CHART_KINDS, Chart, type ChartKind } from "./charts";
import { ChevronIcon } from "./icons";
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
  const bestId = valid.find((s) => effectiveTime(s) === best)?.id;

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

  const stats: { k: string; v: string; hl?: boolean }[] = [
    { k: "best", v: formatTime(best), hl: best !== null },
    { k: "ao5", v: formatTime(averageOf(solves, 5)) },
    { k: "ao12", v: formatTime(averageOf(solves, 12)) },
    { k: "平均", v: formatTime(mean) },
  ];
  return (
    <div class="page data">
      <header class="page-title">
        <h1>データ</h1>
        <span class="page-sub">{solves.length} 回</span>
      </header>
      <section class="stat-tiles" aria-label="成績">
        {stats.map((x) => (
          <div key={x.k} class={`tile${x.hl ? " hl" : ""}`}>
            <span class="k">{x.k}</span>
            <span class="v">{x.v}</span>
          </div>
        ))}
      </section>
      <div class="chart-grid">
        <ChartCard slot={1} fallback="timeline" solves={solves} />
        <ChartCard slot={2} fallback="splits" solves={solves} />
      </div>
      <section class="card history-card">
        <div class="card-head">
          履歴
          <span class="spacer" />
          <span class="muted small">新しい順・押すと詳しく</span>
        </div>
        {solves.length ? (
          <ul class="history-list">
            {solves.map((s, i) => (
              <li key={s.id}>
                <button onClick={() => openSolve(s.id)}>
                  <span class="n">{solves.length - i}</span>
                  <span class="main">
                    <span class={`t${s.id === bestId ? " best" : ""}`}>
                      {formatTime(effectiveTime(s))}
                      {s.penalty === "+2" && <small> +2</small>}
                    </span>
                    <span class="m">{s.moves.length ? `${s.moves.length} 手・${s.tps.toFixed(2)} TPS` : "手順なし"}</span>
                  </span>
                  <span class="side">
                    <AnalysisBadge solve={s} />
                    <span class="d">{new Date(s.date).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                  </span>
                  <ChevronIcon />
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

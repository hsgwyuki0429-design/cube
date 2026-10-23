// ソルブ履歴: 一覧・統計・3D リプレイ・書き出し／読み込み
import { useState } from "preact/hooks";
import { type Solve, averageOf, effectiveTime, formatTime } from "../app/storage";
import { useStore } from "../app/store";
import { deleteSolve, replaceSolves, setPenalty, timerStore } from "../app/timer";
import { Cube3D } from "./Cube3D";
import { AnalysisBadge } from "./TimerPanel";

function download(name: string, text: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function HistoryPage() {
  const solves = useStore(timerStore, (s) => s.solves);
  const [sel, setSel] = useState<string | null>(solves[0]?.id ?? null);
  const selected = solves.find((s) => s.id === sel) ?? null;
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
    <div class="page">
      <h2>履歴</h2>
      <div class="stats" style={{ gridTemplateColumns: "repeat(5, 1fr)", marginBottom: 16 }}>
        <div class="stat">
          <div class="k">回数</div>
          <div class="v">{solves.length}</div>
        </div>
        <div class="stat">
          <div class="k">ベスト</div>
          <div class="v">{formatTime(best)}</div>
        </div>
        <div class="stat">
          <div class="k">平均</div>
          <div class="v">{formatTime(mean)}</div>
        </div>
        <div class="stat">
          <div class="k">ao5</div>
          <div class="v">{formatTime(averageOf(solves, 5))}</div>
        </div>
        <div class="stat">
          <div class="k">ao12</div>
          <div class="v">{formatTime(averageOf(solves, 12))}</div>
        </div>
      </div>
      {selected && (
        <div class="card" style={{ marginBottom: 16 }}>
          <div class="card-head">
            {new Date(selected.date).toLocaleString()} ・ {formatTime(effectiveTime(selected))}
            {selected.penalty && <span class="chip">{selected.penalty}</span>}
            <AnalysisBadge solve={selected} />
            <span class="spacer" />
            <button class="btn small" onClick={() => setPenalty(selected.id, selected.penalty === "+2" ? "" : "+2")}>
              +2
            </button>
            <button class="btn small" onClick={() => setPenalty(selected.id, selected.penalty === "DNF" ? "" : "DNF")}>
              DNF
            </button>
            <button class="btn small danger" onClick={() => confirm("このソルブを削除しますか？") && deleteSolve(selected.id)}>
              削除
            </button>
          </div>
          <div class="card-body" style={{ display: "grid", gridTemplateColumns: "minmax(220px, 320px) 1fr", gap: 16 }}>
            <div>
              <Cube3D key={selected.id} epoch={0} setupMoves={[]} moves={[]} orient={null} controls setupAlg={selected.scramble} alg={selected.moves.map((m) => m.m).join(" ")} />
            </div>
            <div>
              <div class="small muted">スクランブル（白上・緑前）</div>
              <div style={{ fontFamily: "var(--mono)", marginBottom: 10 }}>{selected.scramble}</div>
              <div class="small muted">
                解法（持ち方基準）{selected.moves.length} 手 ・ {selected.tps.toFixed(2)} TPS {selected.tracked ? "" : "・手動停止"}
              </div>
              <div class="moves" style={{ maxHeight: 160 }}>
                {selected.moves.map((m, i) => (
                  <span key={i} class={`mv${m.inferred ? " inferred" : ""}`}>
                    {m.r}
                  </span>
                ))}
              </div>
              {selected.splits && (
                <table class="list split-table small" style={{ marginTop: 10 }}>
                  <tbody>
                    {selected.splits.map((s, i) => {
                      const prev = i ? selected.splits![i - 1] : { t: 0, moves: 0 };
                      return (
                        <tr key={s.name}>
                          <td>{s.name}</td>
                          <td class="muted">{s.moves - prev.moves} 手</td>
                          <td>{formatTime(s.t - prev.t)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              <p class="small muted">3D は下のボタンで再生・巻き戻しできます（3D 内の手順はセンター色基準）。</p>
            </div>
          </div>
        </div>
      )}
      <div class="btn-row" style={{ marginBottom: 10 }}>
        <button class="btn small" onClick={() => download("cubevision-solves.json", JSON.stringify(solves, null, 1), "application/json")} disabled={!solves.length}>
          JSON で書き出す
        </button>
        <button class="btn small" onClick={() => download("cubevision-solves.csv", csv(), "text/csv")} disabled={!solves.length}>
          CSV で書き出す
        </button>
        <button class="btn small" onClick={importJson}>
          JSON を読み込む
        </button>
      </div>
      {solves.length ? (
        <table class="list">
          <thead>
            <tr>
              <th>#</th>
              <th>タイム</th>
              <th>手数</th>
              <th>TPS</th>
              <th>日時</th>
            </tr>
          </thead>
          <tbody>
            {solves.map((s, i) => (
              <tr key={s.id} class={s.id === sel ? "sel" : ""} onClick={() => setSel(s.id)}>
                <td class="muted">{solves.length - i}</td>
                <td>
                  {formatTime(effectiveTime(s))}
                  {s.penalty === "+2" ? " (+2)" : ""}
                </td>
                <td>{s.moves.length}</td>
                <td>{s.tps.toFixed(2)}</td>
                <td class="muted small">{new Date(s.date).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p class="muted">まだソルブがありません。メイン画面の「タイマー」タブから計測できます。</p>
      )}
    </div>
  );
}

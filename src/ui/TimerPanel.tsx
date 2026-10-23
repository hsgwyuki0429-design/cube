// タイマー: スクランブル誘導 → インスペクション → 自動開始・自動停止 → 結果
import { useEffect, useState } from "preact/hooks";
import { controller } from "../app/controller";
import { settingsStore } from "../app/settings";
import { averageOf, formatTime } from "../app/storage";
import { useStore } from "../app/store";
import { cancelTimer, inspectionTick, newScramble, setPenalty, stopManually, timerStore } from "../app/timer";
import { MOVE_NAMES, relativeMove } from "../cube/model";
import { TrackStatus } from "./FreePanel";
import { viewOrient } from "./notation";

function useTicker(active: boolean): number {
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

export function TimerPanel() {
  const t = useStore(timerStore, (s) => s);
  const cube = useStore(controller.store, (s) => s.cube);
  const orient = useStore(controller.store, (s) => s.track?.orient ?? 0);
  const settings = useStore(settingsStore, (s) => ({ notation: s.notation, viewpoint: s.viewpoint, inspection: s.inspection }));
  const now = useTicker(t.phase === "inspection" || t.phase === "solving");

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

  if (!cube) return <div class="status-banner">タイマーを使うには、先にキューブをスキャンしてください（「フリー」タブから）。</div>;
  const label = (m: number) => (settings.notation === "relative" ? MOVE_NAMES[relativeMove(m, viewOrient(orient, settings))] : MOVE_NAMES[m]);
  const ao5 = averageOf(t.solves, 5);
  const ao12 = averageOf(t.solves, 12);
  const best = t.solves.length ? Math.min(...t.solves.map((s) => (s.penalty === "DNF" ? Infinity : s.timeMs + (s.penalty === "+2" ? 2000 : 0)))) : null;

  return (
    <div>
      {(t.phase === "idle" || t.phase === "done") && (
        <>
          {t.phase === "done" && t.result && (
            <div>
              <div class="bigtime">
                {formatTime(t.result.penalty === "DNF" ? Infinity : t.result.timeMs + (t.result.penalty === "+2" ? 2000 : 0))}
                {t.result.penalty === "+2" && <span class="small muted"> (+2)</span>}
              </div>
              <div class="stats">
                <div class="stat">
                  <div class="k">手数</div>
                  <div class="v">{t.result.moves.length}</div>
                </div>
                <div class="stat">
                  <div class="k">TPS</div>
                  <div class="v">{t.result.tps.toFixed(2)}</div>
                </div>
                <div class="stat">
                  <div class="k">計測</div>
                  <div class="v small">{t.result.tracked ? "自動" : "手動停止"}</div>
                </div>
              </div>
              {t.result.splits && (
                <table class="list split-table small" style={{ marginTop: 10 }}>
                  <tbody>
                    {t.result.splits.map((s, i) => {
                      const prev = i ? t.result!.splits![i - 1] : { t: 0, moves: 0 };
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
              <div class="btn-row" style={{ marginTop: 10 }}>
                <button class="btn small" onClick={() => setPenalty(t.result!.id, t.result!.penalty === "+2" ? "" : "+2")}>
                  +2
                </button>
                <button class="btn small" onClick={() => setPenalty(t.result!.id, t.result!.penalty === "DNF" ? "" : "DNF")}>
                  DNF
                </button>
                <button class="btn small" onClick={() => controller.store.set({ screen: "history" })}>
                  リプレイ・履歴
                </button>
              </div>
            </div>
          )}
          <div class="btn-row" style={{ marginTop: 14 }}>
            <button class="btn primary" onClick={() => newScramble()}>
              {t.phase === "done" ? "次のソルブ" : "スクランブルを出す"}
            </button>
          </div>
          {t.message && <p class="muted small">{t.message}</p>}
          <div class="stats" style={{ marginTop: 14 }}>
            <div class="stat">
              <div class="k">ベスト</div>
              <div class="v">{formatTime(best)}</div>
            </div>
            <div class="stat">
              <div class="k">ao5</div>
              <div class="v">{formatTime(ao5)}</div>
            </div>
            <div class="stat">
              <div class="k">ao12</div>
              <div class="v">{formatTime(ao12)}</div>
            </div>
          </div>
          <p class="muted small">
            スクランブルどおりに崩すと自動でインスペクションに入り、最初の1手でタイマーが始まり、揃った瞬間に止まります（スマートキューブと同じ流れ）。
          </p>
        </>
      )}

      {t.phase === "preparing" && <p class="muted">スクランブルを生成中…</p>}

      {t.phase === "scrambling" && (
        <div>
          <TrackStatus />
          <div class="muted small" style={{ marginBottom: 6 }}>
            {t.recomputing ? "手順を計算し直しています…" : `この手順で崩してください（残り ${t.guide.length - t.guideDone} 手・今の持ち方での表記）`}
          </div>
          <div class="scramble">
            {t.guide.map((m, i) => (
              <span key={i} class={`mv ${i < t.guideDone ? "done" : i === t.guideDone ? "next" : ""}`}>
                {label(m)}
              </span>
            ))}
          </div>
          <p class="muted small">公式スクランブル: {t.scramble.map((m) => MOVE_NAMES[m]).join(" ")}（白上・緑前）</p>
          <button class="btn small" onClick={cancelTimer}>
            やめる
          </button>
        </div>
      )}

      {t.phase === "inspection" && (
        <div>
          <div class="bigtime inspection">{settings.inspection ? Math.max(0, 15 - Math.floor(inspectionTick(now) / 1000)) : "Ready"}</div>
          <p class="muted" style={{ textAlign: "center" }}>
            スクランブル完了。最初の1手でタイマーが始まります。
          </p>
          <button class="btn small" onClick={cancelTimer}>
            やめる
          </button>
        </div>
      )}

      {t.phase === "solving" && (
        <div>
          <div class="bigtime solving">{formatTime(now - t.startT)}</div>
          <div class="muted" style={{ textAlign: "center" }}>
            {t.liveMoves} 手
          </div>
          <div class="btn-row" style={{ justifyContent: "center", marginTop: 10 }}>
            <button class="btn" onClick={stopManually}>
              手動で止める <span class="kbd">Space</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

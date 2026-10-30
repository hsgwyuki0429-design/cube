// タイマー: スクランブル誘導 → インスペクション → 自動開始・自動停止 → 結果
import { useEffect, useState } from "preact/hooks";
import { controller } from "../app/controller";
import { settingsStore } from "../app/settings";
import { averageOf, formatTime } from "../app/storage";
import { useStore } from "../app/store";
import { cancelTimer, inspectionTick, newScramble, setPenalty, stopManually, timerStore } from "../app/timer";
import { MOVE_NAMES, relativeMove } from "../cube/model";
import type { Solve } from "../app/storage";
import { TrackStatus } from "./FreePanel";
import { Cube3D } from "./Cube3D";
import { viewOrient } from "./notation";
import { VideoAnalysis } from "./VideoAnalysis";

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

export function AnalysisBadge({ solve, progress }: { solve: Solve; progress?: number }) {
  if (solve.video)
    return (
      <span class="chip analysis done" title="動画ファイル（スロー撮影など）を読み込んで、全フレームを解析した記録です">
        動画（全フレーム解析）
      </span>
    );
  if (solve.analysis === "pending")
    return (
      <span class="chip analysis pending" title="録画を1フレームずつ解析しています。終わるとタイムと手順が確定します">
        解析中{progress !== undefined && progress > 0 ? ` ${Math.round(progress * 100)}%` : "…"}（速報値）
      </span>
    );
  if (solve.analysis === "done")
    return (
      <span class="chip analysis done" title={solve.provisionalMs !== undefined ? `速報値 ${formatTime(solve.provisionalMs)}` : undefined}>
        確定（全フレーム解析）
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

// 止めた後の結果。「タイム」（止めた瞬間に速報、解析で確定）と「手順の再構成」（全フレームを解析して、
// 時間がかかっても正確に）を分けて見せる
function SolveResult({ solve, progress, startedAt, notation }: { solve: Solve; progress: number; startedAt: number; notation: "relative" | "absolute" }) {
  const now = useTicker(solve.analysis === "pending");
  const effective = solve.penalty === "DNF" ? Infinity : solve.timeMs + (solve.penalty === "+2" ? 2000 : 0);
  const pending = solve.analysis === "pending";
  const elapsed = startedAt ? (now - startedAt) / 1000 : 0;
  const eta = pending && progress > 0.05 ? Math.max(0, (elapsed * (1 - progress)) / progress) : null;
  const inferred = solve.moves.filter((m) => m.inferred).length;
  return (
    <div>
      <div class="result-block">
        <div class="result-head">
          タイム
          <span class="spacer" />
          <AnalysisBadge solve={solve} progress={progress} />
        </div>
        <div class="bigtime">
          {formatTime(effective)}
          {solve.penalty === "+2" && <span class="small muted"> (+2)</span>}
        </div>
        <div class="muted small" style={{ textAlign: "center" }}>
          最初の手の回し始め 〜 最後の手の回し終わり{solve.provisionalMs !== undefined && solve.analysis === "done" ? `（速報値 ${formatTime(solve.provisionalMs)}）` : ""}
        </div>
        <div class="btn-row" style={{ justifyContent: "center", marginTop: 8 }}>
          <button class="btn small" onClick={() => setPenalty(solve.id, solve.penalty === "+2" ? "" : "+2")}>
            +2
          </button>
          <button class="btn small" onClick={() => setPenalty(solve.id, solve.penalty === "DNF" ? "" : "DNF")}>
            DNF
          </button>
        </div>
      </div>

      <div class="result-block">
        <div class="result-head">
          手順の再構成
          <span class="spacer" />
          <span class="muted small">{pending ? "録画を全フレーム解析中" : solve.analysis === "done" ? "全フレームから確定" : solve.analysis === "failed" ? "解析できず（リアルタイムの結果）" : "リアルタイムの結果"}</span>
        </div>
        {pending ? (
          <div>
            <div class="progress">
              <div style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <div class="muted small" style={{ marginTop: 6 }}>
              {Math.round(progress * 100)}%{eta !== null ? `・あと約 ${Math.ceil(eta)} 秒` : ""}。指で隠れた手も、スクランブル後と完成の両側から辻褄が合うように解き直しています。
            </div>
          </div>
        ) : (
          <>
            <div class="stats">
              <div class="stat">
                <div class="k">手数</div>
                <div class="v">{solve.moves.length}</div>
              </div>
              <div class="stat">
                <div class="k">TPS</div>
                <div class="v">{solve.tps.toFixed(2)}</div>
              </div>
              <div class="stat">
                <div class="k">推定した手</div>
                <div class="v small">{inferred ? `${inferred} 手` : "なし"}</div>
              </div>
            </div>
            {solve.splits && (
              <table class="list split-table small" style={{ marginTop: 10 }}>
                <tbody>
                  {solve.splits.map((s, i) => {
                    const prev = i ? solve.splits![i - 1] : { t: 0, moves: 0 };
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
            {solve.moves.length > 0 && (
              <div class="moves" style={{ marginTop: 10, maxHeight: 120 }}>
                {solve.moves.map((m, i) => (
                  <span key={i} class={`mv${m.inferred ? " inferred" : ""}`} title={`${(m.t / 1000).toFixed(2)}s${m.inferred ? "（直接は見えず、前後から推定）" : ""}`}>
                    {notation === "relative" ? m.r : m.m}
                  </span>
                ))}
              </div>
            )}
            {solve.moves.length > 0 && solve.scramble && (
              <div style={{ marginTop: 10 }}>
                <div class="muted small">3D で再生（スクランブル後から。3D 内の表記はセンター色基準）</div>
                <div style={{ maxWidth: 320 }}>
                  <Cube3D key={`${solve.id}-${solve.analysis}`} epoch={0} setupMoves={[]} moves={[]} orient={null} controls setupAlg={solve.scramble} alg={solve.moves.map((m) => m.m).join(" ")} />
                </div>
              </div>
            )}
          </>
        )}
        <div class="btn-row" style={{ marginTop: 10 }}>
          <button class="btn small" onClick={() => controller.store.set({ screen: "history" })}>
            履歴
          </button>
        </div>
      </div>
    </div>
  );
}

export function TimerPanel() {
  const t = useStore(timerStore, (s) => s);
  const cube = useStore(controller.store, (s) => s.cube);
  const orient = useStore(controller.store, (s) => s.track?.orient ?? 0);
  const settings = useStore(settingsStore, (s) => ({ notation: s.notation, viewpoint: s.viewpoint, inspection: s.inspection }));
  const now = useTicker(t.phase === "inspection" || t.phase === "solving");
  const [video, setVideo] = useState(false);

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
          {t.phase === "done" && t.result && <SolveResult solve={t.result} progress={t.analysisProgress} startedAt={t.analysisStartedAt} notation={settings.notation} />}
          <div class="btn-row" style={{ marginTop: 14 }}>
            <button class="btn primary" onClick={() => newScramble()}>
              {t.phase === "done" ? "次のソルブ" : "スクランブルを出す"}
            </button>
            <button class="btn" onClick={() => setVideo(true)}>
              スロー動画から記録
            </button>
          </div>
          {video && <VideoAnalysis mode="timer" onClose={() => setVideo(false)} />}
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
            タイムは最初の手の回し始めから最後の手の回し終わりまでで、止めた後に録画を全フレーム解析して確定します。
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

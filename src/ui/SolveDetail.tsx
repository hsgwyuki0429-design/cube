// 記録の詳しい画面: 大きなタイム・3D キューブ（自分の解き方を再生。手や分割タイムを押すとそこから）・分割タイム・手順・スクランブル・
// X クロスの最短（自分がクロスを作った色。押すと 3D でその解き方を再生）・ペナルティと削除・共有
import { useEffect, useState } from "preact/hooks";
import { controller } from "../app/controller";
import { settingsStore } from "../app/settings";
import { effectiveTime, formatTime } from "../app/storage";
import { useStore } from "../app/store";
import { timerStore } from "../app/timer";
import { crossFaceOf } from "../cube/analysis";
import { f2lPlan } from "../cube/f2l";
import { holdWithDown } from "../cube/hold";
import { MOVE_NAMES, applyMoves, moveIndex, parseMoves, relativeMove, rotateOrientation, solvedState } from "../cube/model";
import type { SolveMove } from "../app/storage";
import { optimalXCross } from "../cube/solver";
import type { XCrossResult } from "../cube/xcross";
import { type ReplayMove, ReplayCube } from "./ReplayCube";
import { BackIcon, ShareIcon } from "./icons";
import { shareSolve } from "./shareCard";
import { AnalysisBadge, PenaltyRow, bestGain } from "./solveUi";

const X_STEP_MS = 420; // X クロスの最短を回す間隔
const FACE_COLOR = ["白", "赤", "緑", "黄", "橙", "青"];

const safeMoves = (names: string[]): number[] | null => {
  try {
    return names.map(moveIndex);
  } catch {
    return null;
  }
};

// 手ごとの、カメラから見えていたキューブの向き。以前の記録（o がない）は、持ち方基準の表記 r とキューブ固定の表記 m から、
// 合う向きのうち前の手の向きにいちばん近いもの（同じなら同じ）を選ぶ（表記は自分から見た向きか、カメラから見た向き）
function replayMoves(moves: SolveMove[], ms: number[]): ReplayMove[] {
  // 回し始めがない以前の記録は、回し終わりの 150ms 前から
  let prev: number | null = null;
  return moves.map((m, i) => {
    let o: number | null = m.o ?? null;
    if (o === null) {
      const cands: number[] = [];
      for (let k = 0; k < 24; k++) for (const v of [k, rotateOrientation(k, "y", 2)]) if (MOVE_NAMES[relativeMove(ms[i], v)] === m.r && !cands.includes(k)) cands.push(k);
      o = prev !== null && cands.includes(prev) ? prev : (cands[0] ?? prev);
    }
    prev = o;
    return { move: ms[i], s: m.s ?? m.t - 150, t: m.t, orient: o };
  });
}

export function SolveDetail() {
  const id = useStore(controller.store, (s) => s.solveId);
  const solves = useStore(timerStore, (t) => t.solves);
  const solve = solves.find((s) => s.id === id) ?? null;
  const notation = useStore(settingsStore, (s) => s.notation);
  const viewpoint = useStore(settingsStore, (s) => s.viewpoint);
  const mirror = useStore(controller.store, (s) => s.mirror);
  const demo = useStore(controller.store, (s) => s.demo);
  // 3D で見せるもの: 自分の解き方の k 手目から / X クロスの最短
  const [view, setView] = useState<{ mode: "mine"; at: number } | { mode: "xcross" }>({ mode: "mine", at: 0 });
  const [xcross, setXcross] = useState<{ face: number; result: XCrossResult | null } | "busy" | "error" | null>(null);

  const back = () => controller.store.set({ screen: "data" });
  let scramble: number[] | null = null;
  try {
    scramble = solve?.scramble ? parseMoves(solve.scramble) : null;
  } catch {
    scramble = null;
  }
  const mine = solve ? safeMoves(solve.moves.map((m) => m.m)) : null;
  const start = scramble ? applyMoves(solvedState(), scramble) : null;
  const crossFace = start && mine ? crossFaceOf(start, mine) : -1;
  const face = crossFace >= 0 ? crossFace : 0; // 分からなければ白
  const hold = holdWithDown(face);

  useEffect(() => {
    setView({ mode: "mine", at: 0 });
    setXcross(null);
    if (!start) return;
    let alive = true;
    setXcross("busy");
    optimalXCross(start, face)
      .then((result) => alive && setXcross({ face, result }))
      .catch(() => alive && setXcross("error"));
    return () => {
      alive = false;
    };
  }, [id]);

  if (!solve) {
    return (
      <div class="page solve-detail">
        <div class="detail-nav">
          <button class="icon-btn" onClick={back} aria-label="データに戻る">
            <BackIcon />
          </button>
        </div>
        <p class="muted">この記録は見つかりませんでした（削除されたかもしれません）。</p>
      </div>
    );
  }

  // 3D の持ち方（クロスの面を下）での手の名前
  const held = (ms: number[]) => ms.map((m) => MOVE_NAMES[relativeMove(m, hold.o)]).join(" ");
  const xMoves = view.mode === "xcross" && xcross && typeof xcross === "object" && xcross.result ? xcross.result.moves : [];
  const label = (m: { m: string; r: string }) => (notation === "relative" ? m.r : m.m);
  const splits = solve.splits ?? [];
  const at = view.mode === "mine" ? view.at : -1;

  const n = solves.length - solves.findIndex((s) => s.id === solve.id);
  const pb = bestGain(solves, solve) !== null || (solves.length === 1 && Number.isFinite(effectiveTime(solve)));
  const splitSpan = splits.length ? splits[splits.length - 1].t : 0;

  return (
    <div class="page solve-detail">
      <div class="detail-nav">
        <button class="icon-btn" onClick={back} aria-label="データに戻る">
          <BackIcon />
        </button>
        <span class="nav-title">{n} 回目</span>
        <span class="spacer" />
        <button class="btn small" onClick={() => shareSolve(solve, solves)}>
          <ShareIcon />
          共有
        </button>
      </div>

      <header class="detail-hero">
        <div class="detail-date">{new Date(solve.date).toLocaleString()}</div>
        <div class="detail-time">
          {formatTime(effectiveTime(solve))}
          {solve.penalty === "+2" && <small> +2</small>}
        </div>
        <div class="detail-meta">
          {solve.moves.length} 手・{solve.tps.toFixed(2)} TPS{!solve.tracked && "・手動停止"}
        </div>
        {solve.pad && (
          <div class="detail-meta small muted">
            GAN タイマー
            {solve.pad.visionMs !== undefined && `・カメラ ${formatTime(solve.pad.visionMs)}`}
            {solve.pad.lead !== undefined && `・回し始めまで ${(solve.pad.lead / 1000).toFixed(2)} 秒`}
            {solve.pad.tail !== undefined && `・手を置くまで ${(solve.pad.tail / 1000).toFixed(2)} 秒`}
          </div>
        )}
        <div class="detail-badges">
          {pb && <span class="pb-badge">自己ベスト</span>}
          <AnalysisBadge solve={solve} />
        </div>
      </header>

      <div class="detail-grid">
        <section class="card detail-block cube-block">
          <div class="block-title">
            3D キューブ
            <span class="muted small">{view.mode === "xcross" ? "X クロスの最短" : "自分の解き方"}</span>
          </div>
          {solve.scramble ? (
            view.mode === "mine" && mine ? (
              <ReplayCube
                key={solve.id}
                setupAlg={solve.scramble}
                moves={replayMoves(solve.moves, mine)}
                from={view.at}
                poses={solve.poses}
                onTurn={() => controller.turnSound()}
                mirror={mirror && !demo}
                solverFlip={viewpoint === "user" && !demo}
                downOrient={hold.o}
                downLabel={`定点（${FACE_COLOR[face]}面下）`}
                crossFace={face}
                plan={start ? f2lPlan(start, mine, face) : []}
                labels={solve.moves.map(label)}
              />
            ) : (
              <ReplayCube
                key={`${solve.id}-x`}
                simple
                setupAlg={solve.scramble}
                moves={xMoves.map((m, i) => ({ move: m, s: i * X_STEP_MS, t: i * X_STEP_MS + 220, orient: null }))}
                from={0}
                onTurn={() => controller.turnSound()}
                downOrient={hold.o}
                downLabel=""
                crossFace={face}
                plan={[]}
                labels={xMoves.map((m) => MOVE_NAMES[relativeMove(m, hold.o)])}
              />
            )
          ) : (
            <p class="muted small">スクランブルがない記録です。</p>
          )}
        </section>
        <section class="card detail-block">
          <div class="block-title">
            分割タイム
            <span class="muted small">押すとそこから 3D で</span>
          </div>
          {splits.length ? (
            <>
              <div class="split-bar" aria-hidden="true">
                {splits.map((s, i) => {
                  const prev = i ? splits[i - 1] : { t: 0, moves: 0 };
                  const on = view.mode === "mine" && at >= prev.moves && at < s.moves;
                  return <span key={s.name} class={`seg s${i % 4}${on ? " on" : ""}`} style={{ flexGrow: Math.max(1, s.t - prev.t) / Math.max(1, splitSpan) }} />;
                })}
              </div>
              <table class="split-table">
                <tbody>
                  {splits.map((s, i) => {
                    const prev = i ? splits[i - 1] : { t: 0, moves: 0 };
                    const from = prev.moves;
                    return (
                      <tr key={s.name} class={view.mode === "mine" && at >= from && at < s.moves ? "on" : ""} onClick={() => setView({ mode: "mine", at: from })}>
                        <td>
                          <span class={`dot s${i % 4}`} />
                          {s.name}
                        </td>
                        <td>{formatTime(s.t - prev.t)}</td>
                        <td class="muted">{s.moves - prev.moves} 手</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          ) : (
            <p class="muted small">手順が完成までつながらなかったので、区切れませんでした。</p>
          )}
        </section>
      </div>

      <section class="card detail-block">
        <div class="block-title">
          手順
          <span class="muted small">押すとその手から 3D で</span>
        </div>
        {solve.moves.length ? (
          <div class="moves">
            {solve.moves.map((m, i) => (
              <button key={i} class={`mv${m.inferred ? " inferred" : ""}${at === i ? " next" : ""}`} title={`${(m.t / 1000).toFixed(2)}s${m.inferred ? "（直接は見えず、前後から推定）" : ""}`} onClick={() => setView({ mode: "mine", at: i })}>
                {label(m)}
              </button>
            ))}
          </div>
        ) : (
          <p class="muted small">手順はありません。</p>
        )}
      </section>

      <section class="card detail-block">
        <div class="block-title">スクランブル</div>
        <div class="scramble-text">{solve.scramble || "—"}</div>
      </section>

      <section class="card detail-block">
        <div class="block-title">
          X クロスの最短
          <span class="muted small">{FACE_COLOR[face]}クロス{crossFace < 0 ? "（クロスの色が分からないので白）" : ""}・{FACE_COLOR[face]}を下</span>
        </div>
        {xcross === "busy" || xcross === null ? (
          <p class="muted small">計算しています…</p>
        ) : xcross === "error" || !xcross.result ? (
          <p class="muted small">求められませんでした。</p>
        ) : (
          <button class={`xcross-row${view.mode === "xcross" ? " on" : ""}`} onClick={() => setView(view.mode === "xcross" ? { mode: "mine", at: 0 } : { mode: "xcross" })}>
            <span class="xcross-moves">{held(xcross.result.moves) || "（もう揃っています）"}</span>
            <span class="muted small">{xcross.result.moves.length} 手・{view.mode === "xcross" ? "自分の解き方に戻す" : "押すと 3D で"}</span>
          </button>
        )}
      </section>

      <PenaltyRow solve={solve} full onDeleted={back} />
    </div>
  );
}

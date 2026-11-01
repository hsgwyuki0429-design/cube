// 記録の詳しい画面: スクランブル・分割タイム・3D キューブ（自分の解き方を再生。手や分割タイムを押すとそこへ）・手順・
// X クロスの最短（自分がクロスを作った色。押すと 3D でその解き方を再生）・ペナルティと削除
import { useEffect, useState } from "preact/hooks";
import { controller } from "../app/controller";
import { settingsStore } from "../app/settings";
import { effectiveTime, formatTime } from "../app/storage";
import { useStore } from "../app/store";
import { timerStore } from "../app/timer";
import { crossFaceOf } from "../cube/analysis";
import { holdWithDown } from "../cube/hold";
import { MOVE_NAMES, applyMoves, moveIndex, parseMoves, relativeMove, solvedState } from "../cube/model";
import { optimalXCross } from "../cube/solver";
import type { XCrossResult } from "../cube/xcross";
import { Cube3D } from "./Cube3D";
import { BackIcon } from "./icons";
import { AnalysisBadge, PenaltyRow } from "./solveUi";

const FACE_COLOR = ["白", "赤", "緑", "黄", "橙", "青"];

const safeMoves = (names: string[]): number[] | null => {
  try {
    return names.map(moveIndex);
  } catch {
    return null;
  }
};

export function SolveDetail() {
  const id = useStore(controller.store, (s) => s.solveId);
  const solve = useStore(timerStore, (t) => t.solves.find((s) => s.id === id) ?? null);
  const notation = useStore(settingsStore, (s) => s.notation);
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
        <button class="btn ghost back" onClick={back}>
          <BackIcon /> データ
        </button>
        <p class="muted">この記録は見つかりませんでした（削除されたかもしれません）。</p>
      </div>
    );
  }

  // 3D の持ち方（クロスの面を下）での手の名前
  const held = (ms: number[]) => ms.map((m) => MOVE_NAMES[relativeMove(m, hold.o)]).join(" ");
  const setupBase = `${solve.scramble} ${hold.rotation}`.trim();
  let setupAlg = setupBase;
  let alg = "";
  if (view.mode === "xcross" && xcross && typeof xcross === "object" && xcross.result) alg = held(xcross.result.moves);
  else if (mine) {
    const at = view.mode === "mine" ? view.at : 0;
    setupAlg = `${setupBase} ${held(mine.slice(0, at))}`.trim();
    alg = held(mine.slice(at));
  }
  const label = (m: { m: string; r: string }) => (notation === "relative" ? m.r : m.m);
  const splits = solve.splits ?? [];
  const at = view.mode === "mine" ? view.at : -1;

  return (
    <div class="page solve-detail">
      <div class="detail-head">
        <button class="btn ghost back" onClick={back} aria-label="データに戻る">
          <BackIcon />
        </button>
        <div>
          <div class="detail-time">
            {formatTime(effectiveTime(solve))}
            {solve.penalty === "+2" && <small> (+2)</small>}
          </div>
          <div class="muted small">
            {new Date(solve.date).toLocaleString()}・{solve.moves.length} 手・{solve.tps.toFixed(2)} TPS {!solve.tracked && "・手動停止"}
          </div>
        </div>
        <span class="spacer" />
        <AnalysisBadge solve={solve} />
      </div>

      <section class="card detail-block">
        <div class="block-title">スクランブル</div>
        <div class="mono scramble-text">{solve.scramble || "—"}</div>
      </section>

      <div class="detail-grid">
        <section class="card detail-block">
          <div class="block-title">分割タイム</div>
          {splits.length ? (
            <table class="split-table">
              <tbody>
                {splits.map((s, i) => {
                  const prev = i ? splits[i - 1] : { t: 0, moves: 0 };
                  const from = prev.moves;
                  return (
                    <tr key={s.name} class={view.mode === "mine" && at >= from && at < s.moves ? "on" : ""} onClick={() => setView({ mode: "mine", at: from })}>
                      <td>{s.name}</td>
                      <td>{formatTime(s.t - prev.t)}</td>
                      <td class="muted">{s.moves - prev.moves} 手</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p class="muted small">手順が完成までつながらなかったので、区切れませんでした。</p>
          )}
        </section>
        <section class="card detail-block cube-block">
          <div class="block-title">
            3D キューブ
            <span class="muted small">{view.mode === "xcross" ? "X クロスの最短" : "自分の解き方"}</span>
          </div>
          {solve.scramble ? (
            <Cube3D key={solve.id} epoch={0} setupMoves={[]} moves={[]} orient={null} controls setupAlg={setupAlg} alg={alg} />
          ) : (
            <p class="muted small">スクランブルがない記録です。</p>
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
            <span class="mono">{held(xcross.result.moves) || "（もう揃っています）"}</span>
            <span class="muted small">{xcross.result.moves.length} 手・{view.mode === "xcross" ? "自分の解き方に戻す" : "押すと 3D で"}</span>
          </button>
        )}
      </section>

      <PenaltyRow solve={solve} full onDeleted={back} />
    </div>
  );
}

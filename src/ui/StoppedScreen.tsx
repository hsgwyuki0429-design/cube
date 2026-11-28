// 止めた後の画面（タイマーの done の間）: カメラの映像を隠し（カメラは止めない）、真ん中にキューブを出して、精密解析の待ちを見せ場にする。
// 画面録画がそのまま縦動画になる。4 つの段:
//   1. 録画を読む: 精密解析の Worker が処理したフレームで直接読めたマスを、2D の等角のキューブで（左と下の面は鏡に映して）。下に時間軸の
//      どこまで読んだか・区間ごとの読めた量・いま読めたマス・読み終えたフレーム
//   2. 解き直し: 「探索の枝」。左（スクランブル）から前向き、右（揃い）から後ろ向き。合わない枝は消え、つないだら決まる。真ん中に止めた
//      ときのキューブを薄く
//   3. 答えが出たら、その場で 3D で手順を実際の速さで再現（記録のリプレイ ReplayCube）。いまの区切り・手順（いまの手を黄色）・区切りの帯と再生位置
//   4. 結果カード
// 知らせは精密解析の Worker から（src/app/stopShow.ts・src/vision/showFeed.ts）。途中の前向きだけの答えは出さない（巻き戻しが起きる）。
// 速報値（failed）は再現なしで結果カード、一部推定（partial）は再現するが端が不確かなことを出す
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { controller, displayColors } from "../app/controller";
import { settingsStore } from "../app/settings";
import { type Solve, effectiveTime, formatTime } from "../app/storage";
import { readBins, showStore } from "../app/stopShow";
import { useStore } from "../app/store";
import { newScramble, timerStore } from "../app/timer";
import { ARUCO_NAMES } from "../aruco/palette";
import { cfopPhases } from "../cube/analysis";
import { f2lPlan } from "../cube/f2l";
import { holdWithDown } from "../cube/hold";
import { type CubeState, applyMoves, moveIndex, parseMoves, solvedState } from "../cube/model";
import { pllName } from "../cube/pll";
import type { SearchShow } from "../vision/showProtocol";
import { ReplayCube } from "./ReplayCube";
import { replayMoves } from "./SolveDetail";
import { shareSolve } from "./shareCard";
import { PenaltyRow, bestGain, openSolve } from "./solveUi";
import { drawBranches, drawIsoCube } from "./stopDraw";

const STICKER = displayColors(ARUCO_NAMES); // 面ごとの表示色（揃った状態の facelet の面 → 色）
const BINS = 16;

type Stage = "read" | "search" | "replay" | "card";

const sec = (ms: number) => (Math.max(0, ms) / 1000).toFixed(ms >= 100000 ? 0 : ms >= 10000 ? 1 : 2);
const sec1 = (ms: number) => (Math.max(0, ms) / 1000).toFixed(1);

// 記録の手順を解析しやすい形に（読めない記録は null）
function solveData(r: Solve) {
  let start: CubeState;
  let moves: number[];
  try {
    start = applyMoves(solvedState(), parseMoves(r.scramble));
    moves = r.moves.map((m) => moveIndex(m.m));
  } catch {
    return null;
  }
  const cfop = moves.length ? cfopPhases(start, moves) : null;
  const end = (i: number) => (i > 0 ? r.moves[i - 1].t : 0);
  const phases = cfop
    ? cfop.phases.map((p, i) => ({ name: p.name, index: p.index, from: i ? cfop.phases[i - 1].index : 0, t0: i ? end(cfop.phases[i - 1].index) : 0, t1: end(p.index) }))
    : [];
  const oll = cfop?.phases.find((p) => p.name === "OLL");
  const pll = cfop && oll ? pllName(cfop.states[oll.index], cfop.face) : null;
  return { start, moves, cfop, phases, pll, face: cfop?.face ?? 0 };
}

// 区切りの名前（大きく出す）
const PHASE_LABEL: Record<string, string> = { クロス: "クロス", "F2L 1": "F2L 1 つ目", "F2L 2": "F2L 2 つ目", "F2L 3": "F2L 3 つ目", "F2L 4": "F2L 4 つ目", OLL: "OLL", PLL: "PLL" };

// ---- 2D の等角のキューブ（canvas） ----

function IsoCanvas({ colors, mirrors, dim, cls }: { colors: (string | null)[]; mirrors: boolean; dim?: number; cls: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const key = colors.join();
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const draw = () => drawIsoCube(c, { colors, mirrors, dim, labels: mirrors ? { left: "左（鏡）", down: "下（鏡）" } : undefined });
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [key, mirrors, dim]);
  return <canvas ref={ref} class={cls} aria-hidden="true" />;
}

// 状態の上・右・正面（白上・緑前）の色
const stateColors = (s: ArrayLike<number>): (string | null)[] => Array.from({ length: 45 }, (_, i) => (i < 27 ? STICKER[s[i] ?? 0] : null));

// ---- 1. 録画を読む ----

function ReadStage({ startT, endT }: { startT: number; endT: number }) {
  const read = useStore(showStore, (s) => s.read);
  const chunks = useStore(showStore, (s) => s.chunks);
  const dur = Math.max(1, endT - startT);
  const pos = read ? Math.min(dur, Math.max(0, read.t - startT)) : 0;
  const colors = useMemo(() => (read ? read.ids.map((id) => (id >= 0 ? STICKER[Math.floor(id / 9)] : null)) : new Array<string | null>(45).fill(null)), [read]);
  const bins = useMemo(() => readBins(chunks, startT, endT, BINS), [chunks, startT, endT]);
  const top = Math.max(6, ...bins.map((v) => v ?? 0));
  return (
    <>
      <div class="sp-stage">
        <IsoCanvas cls="sp-iso" colors={colors} mirrors />
      </div>
      <section class="sp-card" aria-label="録画を読んでいます">
        <div class="sp-head">
          <b>録画を読んでいます</b>
          <span>
            {sec1(pos)} / {sec1(dur)} 秒
          </span>
        </div>
        <div class="sp-bins" aria-hidden="true">
          {bins.map((v, i) => (
            <i key={i} class={v === null ? "none" : (i + 0.5) / BINS > pos / dur ? "later" : ""} style={{ height: `${v === null ? 6 : Math.max(8, (v / top) * 100)}%` }} />
          ))}
        </div>
        <div class="sp-progress" aria-hidden="true">
          <div style={{ width: `${(pos / dur) * 100}%` }} />
        </div>
        <div class="sp-stats">
          <div>
            <small>いま読めたマス</small>
            <b>{read ? read.cells : "—"}</b>
          </div>
          <div>
            <small>読み終えたフレーム</small>
            <b>{read ? `${read.done} / ${read.total}` : "—"}</b>
          </div>
        </div>
        <p class="sp-note">色は読めたマス、黒は読めていないマス。左と下の面は鏡に映して見せています。</p>
      </section>
    </>
  );
}

// ---- 2. 解き直し: 探索の枝 ----

const STAGE_NAME: Record<SearchShow["stage"], string> = { first: "1 回目", deep: "深く探し直し", stop: "止めた所で解き直し" };
const log2 = (n: number) => Math.log2(Math.max(1, n));

function SearchStage({ startT, endT, stopColors }: { startT: number; endT: number; stopColors: (string | null)[] }) {
  const s = useStore(showStore, (x) => x.search);
  const ref = useRef<HTMLCanvasElement>(null);
  const dur = Math.max(1, endT - startT);
  const at = (t: number | null) => (t === null ? null : Math.min(1, Math.max(0, (t - startT) / dur)));
  const label = !s ? "" : s.meetT !== null ? "つながった" : s.step === "bridge" ? "隠れた区間を橋渡し" : s.step === "finish" ? "見えない手を補う" : "ここをつなぐ";
  useEffect(() => {
    const c = ref.current;
    if (!c || !s) return;
    const draw = () =>
      drawBranches(c, {
        fwd: { x: at(s.f.t), alive: Math.min(6, Math.round(log2(s.f.near)) + 1), dead: Math.min(14, Math.round(log2(s.f.dropped + 1) * 1.4)) },
        bwd: { x: at(s.b.t), alive: Math.min(6, Math.round(log2(s.b.near)) + 1), dead: Math.min(14, Math.round(log2(s.b.dropped + 1) * 1.4)) },
        meet: at(s.meetT),
        color: "#4f8cff",
        label,
      });
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [s, startT, endT]);
  const dir = (d: SearchShow["f"], arrow: string) => (
    <div>
      <small>
        {arrow} {d.t === null ? "これから" : `${sec1(Math.max(0, d.t - startT))} 秒まで`}
      </small>
      <b>
        仮説 {d.hyps}
        <em>（有力 {d.near}）</em>
      </b>
      <small>落とした {d.dropped.toLocaleString()}</small>
    </div>
  );
  return (
    <>
      <div class="sp-stage">
        <IsoCanvas cls="sp-iso small" colors={stopColors} mirrors={false} dim={0.35} />
        <p class="sp-caption">答えが決まったら、このキューブで再現します</p>
      </div>
      <section class="sp-card" aria-label="手順を探しています">
        <div class="sp-head">
          <b>手順を探しています</b>
          <span>{s ? STAGE_NAME[s.stage] : ""}</span>
        </div>
        <canvas ref={ref} class="sp-branches" aria-hidden="true" />
        <div class="sp-axis" aria-hidden="true">
          <span>スクランブル・0 秒</span>
          <span>{sec1(dur / 2)} 秒</span>
          <span>{sec1(dur)} 秒・揃い</span>
        </div>
        {s && (
          <div class="sp-stats">
            {dir(s.f, "前向き →")}
            {dir(s.b, "← 後ろ向き")}
          </div>
        )}
        <p class="sp-note">合わない枝は消えていき、真ん中でつながったら答えが決まります。</p>
      </section>
    </>
  );
}

// ---- 3. その場で再現 ----

function ReplayStage({ r, data, onEnd, playKey }: { r: Solve; data: NonNullable<ReturnType<typeof solveData>>; onEnd: () => void; playKey: number }) {
  const notation = useStore(settingsStore, (s) => s.notation);
  const [at, setAt] = useState(0);
  const [slow, setSlow] = useState(false);
  const [key, setKey] = useState(0);
  const clock = useRef<HTMLSpanElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const total = r.moves.length ? r.moves[r.moves.length - 1].t : 1;
  const hold = holdWithDown(data.face);
  const plan = useMemo(() => f2lPlan(data.start, data.moves, data.face), [r.id]);
  const rmoves = useMemo(() => replayMoves(r.moves, data.moves), [r.id, r.moves]);
  const labels = r.moves.map((m) => (notation === "relative" ? m.r : m.m));
  const cur = Math.max(0, at - 1); // いま回している手
  const phase = data.phases.find((p) => p.index > cur && p.index > p.from) ?? data.phases[data.phases.length - 1];
  const onClock = (real: number) => {
    const t = Math.min(total, Math.max(0, real));
    if (clock.current) clock.current.textContent = sec(t);
    if (head.current) head.current.style.left = `${(t / Math.max(1, total)) * 100}%`;
  };
  const win = r.moves.map((m, i) => ({ m, i })).slice(Math.max(0, cur - 6), cur + 4);
  const inferred = r.moves.filter((m) => m.inferred).length;
  return (
    <>
      <div class="sp-stage replay">
        <div class="sp-replay">
          <ReplayCube
            bare
            setupAlg={r.scramble}
            moves={rmoves}
            from={0}
            poses={r.poses}
            onTurn={() => controller.turnSound()}
            downOrient={hold.o}
            downLabel=""
            crossFace={data.face}
            plan={plan}
            labels={labels}
            slow={slow ? 2 : 1}
            playKey={playKey * 1000 + key}
            onAt={setAt}
            onClock={onClock}
            onEnd={onEnd}
          />
        </div>
        <div class="sp-phase">
          <b>{phase ? (PHASE_LABEL[phase.name] ?? phase.name) : ""}</b>
          <span>
            <span ref={clock}>0.00</span> 秒 / {formatTime(effectiveTime(r))}
          </span>
        </div>
      </div>
      <section class="sp-replay-panel" aria-label="手順">
        <div class="sp-moves">
          {win.map(({ m, i }) => (
            <span key={i} class={`mv${i === cur && at > 0 ? " now" : i < cur ? " past" : ""}${m.inferred ? " inferred" : ""}`} title={m.inferred ? "推定の手（直接は見えなかった）" : undefined}>
              {labels[i]}
            </span>
          ))}
          <span class="sp-count">
            {Math.min(at, r.moves.length)} / {r.moves.length} 手
          </span>
        </div>
        {inferred > 0 && <p class="sp-note">点線の手は推定（直接は見えなかった手）です。</p>}
        {r.analysis === "partial" && <p class="sp-note warn">{edgeNote(r)}</p>}
        <div class="sp-band" aria-hidden="true">
          <div class="segs">
            {data.phases
              .filter((p) => p.index > p.from)
              .map((p) => (
                <i key={p.name} class={`${p.name === phase?.name ? "on" : ""} ${p.name.startsWith("F2L") ? "f2l" : p.name === "クロス" ? "cross" : p.name.toLowerCase()}`} style={{ flex: `${Math.max(1, p.t1 - p.t0)} 1 0` }} />
              ))}
          </div>
          <div class="head" ref={head} />
          <div class="names">
            <span>クロス</span>
            <span>F2L 1〜4</span>
            <span>OLL</span>
            <span>PLL</span>
          </div>
        </div>
        <div class="sp-actions">
          <button class="sp-text" aria-pressed={slow} onClick={() => setSlow(!slow)}>
            スロー
          </button>
          <button class="sp-text" onClick={() => setKey(key + 1)}>
            もう一度
          </button>
          <span class="spacer" />
          <button class="sp-text strong" onClick={onEnd}>
            結果へ
          </button>
        </div>
      </section>
    </>
  );
}

function edgeNote(r: Solve): string {
  const e = r.liveEdges ?? [];
  const which = e.length === 2 ? "始まりと終わり" : e[0] === "start" ? "始まり" : e[0] === "end" ? "終わり" : "端の一部";
  return `タイムの${which}は録画から決められず、リアルタイムの値です（端の手の層が写っていない・手動で止めた）。`;
}

// ---- 4. 結果カード ----

function ResultCard({ r, data, solves, onAgain }: { r: Solve; data: ReturnType<typeof solveData>; solves: Solve[]; onAgain: (() => void) | null }) {
  const inferred = r.moves.filter((m) => m.inferred).length;
  const phases = data?.phases ?? [];
  const f2l = phases.filter((p) => p.name.startsWith("F2L"));
  const row = (name: string) => phases.find((p) => p.name === name);
  const span = (p?: { t0: number; t1: number }) => (p ? p.t1 - p.t0 : 0);
  const groups = phases.length
    ? [
        { name: "クロス", cls: "cross", ms: span(row("クロス")) },
        { name: "F2L", cls: "f2l", ms: f2l.reduce((a, p) => a + span(p), 0) },
        { name: "OLL", cls: "oll", ms: span(row("OLL")) },
        { name: "PLL", cls: "pll", ms: span(row("PLL")) },
      ]
    : [];
  const pll = data?.pll === "skip" ? "スキップ" : data?.pll ? `${data.pll}-perm` : "";
  const reads = r.liveReads;
  const settle = r.settleMs !== undefined ? `（止めてから ${sec1(r.settleMs)} 秒）` : "";
  const how =
    r.analysis === "done"
      ? `録画から確定しました${settle}`
      : r.analysis === "partial"
        ? `録画から確定しました（一部推定）${settle}`
        : r.analysis === "failed"
          ? `速報値です: 録画から完成までをたどれませんでした${settle}`
          : r.analysis === "pending"
            ? "録画を解析しています"
            : "リアルタイムの結果です";
  return (
    <>
      <div class="sp-stage card">
        <IsoCanvas cls="sp-iso tiny" colors={stateColors(data ? applyMoves(data.start, data.moves) : solvedState())} mirrors={false} />
      </div>
      <section class="sp-card result" aria-label="結果">
        <div class="sp-nums">
          <div>
            <small>手数</small>
            <b>{r.moves.length}</b>
          </div>
          <div>
            <small>TPS</small>
            <b>{r.tps.toFixed(2)}</b>
          </div>
          <div>
            <small>推定の手</small>
            <b>{inferred}</b>
          </div>
        </div>
        {groups.length > 0 && (
          <>
            <div class="sp-split-bar" aria-hidden="true">
              {groups.map((g) => (
                <i key={g.name} class={g.cls} style={{ flex: `${Math.max(1, g.ms)} 1 0` }} />
              ))}
            </div>
            <ul class="sp-splits">
              {groups.map((g) => (
                <li key={g.name}>
                  <i class={g.cls} />
                  <span>
                    {g.name}
                    {g.name === "F2L" && <em>{f2l.map((p) => sec(span(p))).join("・")}</em>}
                    {g.name === "PLL" && pll && <em>{pll}</em>}
                  </span>
                  <b>{sec(g.ms)}</b>
                </li>
              ))}
            </ul>
          </>
        )}
        {r.analysis === "partial" && <p class="sp-note warn">{edgeNote(r)}</p>}
        <div class="sp-foot">
          {reads && (
            <div class="sp-reads">
              <span>ライブが読んだマス</span>
              <b>
                {reads.cells.toLocaleString()}
                <em>1 フレーム平均 {(reads.cells / Math.max(1, reads.frames)).toFixed(1)}</em>
              </b>
            </div>
          )}
          <p class={`sp-how${r.analysis === "failed" ? " warn" : ""}`}>{how}</p>
        </div>
      </section>
      <div class="sp-card-actions">
        <button class="btn primary sp-next" onClick={() => newScramble()}>
          次のソルブ
        </button>
        <div class="sp-links">
          {onAgain && (
            <button class="sp-text" onClick={onAgain}>
              もう一度見る
            </button>
          )}
          <button class="sp-text" onClick={() => openSolve(r.id)}>
            詳しく
          </button>
          <button class="sp-text" onClick={() => shareSolve(r, solves)}>
            共有
          </button>
          <PenaltyRow solve={r} />
        </div>
      </div>
    </>
  );
}

// ---- 上: タイムと段の札 ----

function StoppedTop({ r, stage, solves }: { r: Solve; stage: Stage; solves: Solve[] }) {
  const gain = bestGain(solves, r);
  const inferred = r.moves.filter((m) => m.inferred).length;
  let chip: preact.JSX.Element | null = null;
  if (stage === "read") chip = <span class="sp-chip live">録画を読んでいます</span>;
  else if (stage === "search") chip = <span class="sp-chip live">手順を確かめています</span>;
  else if (stage === "replay") chip = <span class={`sp-chip ok${r.analysis === "partial" ? " warn" : ""}`}>{r.analysis === "partial" ? `確定（一部推定）・推定 ${inferred} 手` : `確定・推定 ${inferred} 手`}</span>;
  else if (gain !== null) chip = <span class="pb-badge">自己ベスト −{(gain / 1000).toFixed(2)}</span>;
  else if (r.analysis === "failed") chip = <span class="sp-chip bad">速報値</span>;
  else if (r.analysis === "partial") chip = <span class="sp-chip warn">確定（一部推定）</span>;
  else if (r.analysis === "done") chip = <span class="sp-chip ok">確定</span>;
  return (
    <div class={`sp-top${stage === "card" && gain !== null ? " pb" : ""}`}>
      <div class="time-value" key={`t-${r.id}`}>
        {formatTime(effectiveTime(r))}
        {r.penalty === "+2" && <small> +2</small>}
      </div>
      <div class="sp-chips" key={stage}>
        {chip}
      </div>
    </div>
  );
}

// ---- 全体 ----

export function StoppedScreen() {
  const r = useStore(timerStore, (t) => (t.phase === "done" ? t.result : null));
  if (!r) return null;
  return <Stopped key={r.id} />;
}

function Stopped() {
  const r = useStore(timerStore, (t) => t.result)!;
  const startT = useStore(timerStore, (t) => t.startT);
  const solves = useStore(timerStore, (t) => t.solves);
  const searching = useStore(showStore, (s) => s.search !== null);
  // 止めたときのキューブ（解き直しの段に薄く）
  const [stopColors] = useState(() => stateColors(controller.store.get().track?.state ?? solvedState()));
  const [manual, setManual] = useState<"replay" | "card" | null>(null);
  const [playKey, setPlayKey] = useState(0);
  const endT = startT + (r.provisionalMs ?? r.timeMs);
  const data = useMemo(() => solveData(r), [r.id, r.analysis, r.moves.length, r.scramble]);
  const canReplay = (r.analysis === "done" || r.analysis === "partial") && !!data && data.moves.length > 0;
  let stage: Stage;
  if (r.analysis === "pending") stage = searching ? "search" : "read";
  else if (manual === "card" || !canReplay) stage = "card";
  else stage = "replay";
  // 画面の段（E2E・画面録画の確かめ用）
  useEffect(() => {
    (window as unknown as { __cubevisionStopStage?: Stage }).__cubevisionStopStage = stage;
  }, [stage]);
  return (
    <div class={`stopped stage-${stage}`}>
      <StoppedTop r={r} stage={stage} solves={solves} />
      {stage === "read" && <ReadStage startT={startT} endT={endT} />}
      {stage === "search" && <SearchStage startT={startT} endT={endT} stopColors={stopColors} />}
      {stage === "replay" && data && <ReplayStage r={r} data={data} playKey={playKey} onEnd={() => setManual("card")} />}
      {stage === "card" && (
        <ResultCard
          r={r}
          data={data}
          solves={solves}
          onAgain={
            canReplay
              ? () => {
                  setPlayKey(playKey + 1);
                  setManual("replay");
                }
              : null
          }
        />
      )}
    </div>
  );
}

// フリー追跡: 状態表示・手順ログ・統計・解法ガイド
import { useEffect, useRef, useState } from "preact/hooks";
import { controller } from "../app/controller";
import { settingsStore } from "../app/settings";
import { useStore } from "../app/store";
import { type CubeState, MOVE_NAMES, applyMoves, isSolved, relativeMove, statesEqual } from "../cube/model";
import { solveState } from "../cube/solver";
import { mergeQuickRepeats, simplifyMoves } from "../track/merge";
import { viewOrient } from "./notation";
import { VideoAnalysis } from "./VideoAnalysis";

// カメラの実測 fps が低いと速い回転を取りこぼす（暗い場所ではカメラが露光を伸ばして fps が落ちる）
function FpsWarning() {
  const w = useStore(controller.store, (s) => s.camera === "on" && !s.demo && s.stats.camFps > 0 && s.stats.camFps < 20);
  if (!w) return null;
  return <div class="status-banner warn small">カメラの fps が低くなっています。部屋を明るくすると、速い回転も追いやすくなります。</div>;
}

export function TrackStatus() {
  return (
    <>
      <TrackStatusBanner />
      <FpsWarning />
    </>
  );
}

function TrackStatusBanner() {
  const t = useStore(controller.store, (s) => ({ status: s.track?.status ?? "tracking", solved: s.track?.solved ?? false, faces: s.stats.faces, has: !!s.track }));
  if (t.status === "lost")
    return (
      <div class="status-banner bad">
        <strong>見失いました</strong>
        読み取った色が、どの手順でも説明できなくなりました。キューブを止めて2面をカメラに見せてください。戻らないときは「再スキャン」か、揃えてから「完成状態にリセット」を押してください。
      </div>
    );
  if (t.status === "uncertain")
    return (
      <div class="status-banner warn">
        <strong>確認中…</strong>
        読み取りが少し合いません。キューブを一瞬止めて、正面と上面がよく見えるように持ってください。
      </div>
    );
  if (t.solved && t.has)
    return (
      <div class="status-banner ok">
        <strong>完成しています 🎉</strong>
        回すとそのまま追跡を続けます。
      </div>
    );
  return (
    <div class={`status-banner ${t.faces ? "ok" : "warn"}`}>
      <strong>{t.faces ? "追跡中" : "キューブを映してください"}</strong>
      {t.faces >= 2 ? "2面以上見えています（良い状態です）。" : t.faces === 1 ? "1面だけ見えています。少し上から映して上面も見えるようにすると精度が上がります。" : "カメラにキューブを向けてください。"}
    </div>
  );
}

function useElapsed(running: boolean, start: number) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => tick((n) => n + 1), 200);
    return () => clearInterval(id);
  }, [running]);
  return running ? performance.now() - start : 0;
}

function SolutionGuide() {
  const track = useStore(controller.store, (s) => s.track);
  const cube = useStore(controller.store, (s) => s.cube);
  const settings = useStore(settingsStore, (s) => ({ notation: s.notation, viewpoint: s.viewpoint }));
  const [guide, setGuide] = useState<{ moves: number[]; states: CubeState[]; done: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(0);
  const state = track ? Uint8Array.from(track.state) : cube ? Uint8Array.from(cube.state) : null;

  const compute = async (from: CubeState) => {
    setBusy(true);
    const id = ++pending.current;
    try {
      const moves = await solveState(from);
      if (id !== pending.current) return;
      const states = [from];
      for (const m of moves) states.push(applyMoves(states[states.length - 1], [m]));
      setGuide({ moves, states, done: 0 });
    } finally {
      if (id === pending.current) setBusy(false);
    }
  };

  useEffect(() => {
    if (!guide || !state) return;
    const k = guide.states.findIndex((g, i) => i >= guide.done && statesEqual(g, state));
    if (k >= 0 && k !== guide.done) setGuide({ ...guide, done: k });
    else if (k < 0 && !busy) compute(state);
  }, [track?.observations]);

  if (!state) return null;
  if (!guide)
    return (
      <button class="btn" disabled={busy || isSolved(state)} onClick={() => compute(state)}>
        {busy ? "計算中…" : "解法を表示"}
      </button>
    );
  const orient = track?.orient ?? 0;
  const label = (m: number) => (settings.notation === "relative" ? MOVE_NAMES[relativeMove(m, viewOrient(orient, settings))] : MOVE_NAMES[m]);
  const finished = guide.done >= guide.moves.length;
  return (
    <div>
      <div class="muted small" style={{ marginBottom: 6 }}>
        {finished ? "完成しました！" : `残り ${guide.moves.length - guide.done} 手（今の持ち方での表記）。光っている手を回してください。`}
      </div>
      <div class="moves">
        {guide.moves.map((m, i) => (
          <span key={i} class={`mv ${i < guide.done ? "done" : i === guide.done ? "next" : ""}`}>
            {label(m)}
          </span>
        ))}
      </div>
      <div class="btn-row" style={{ marginTop: 8 }}>
        <button class="btn small" onClick={() => setGuide(null)}>
          閉じる
        </button>
      </div>
    </div>
  );
}

export function FreePanel() {
  const track = useStore(controller.store, (s) => s.track);
  const base = useStore(controller.store, (s) => s.baseMoves);
  const moves = track?.moves ?? [];
  const recent = simplifyMoves(mergeQuickRepeats(moves.slice(base)));
  const startT = recent[0]?.t ?? 0;
  const lastT = recent[recent.length - 1]?.t ?? 0;
  const running = recent.length > 0 && !track?.solved;
  const elapsed = useElapsed(running, startT);
  const duration = running ? elapsed : lastT - startT;
  const tps = recent.length > 1 && lastT > startT ? (recent.length - 1) / ((lastT - startT) / 1000) : 0;
  const [video, setVideo] = useState(false);

  return (
    <div>
      <TrackStatus />
      <div class="stats">
        <div class="stat">
          <div class="k">手数</div>
          <div class="v">{recent.length}</div>
        </div>
        <div class="stat">
          <div class="k">TPS</div>
          <div class="v">{tps ? tps.toFixed(2) : "—"}</div>
        </div>
        <div class="stat">
          <div class="k">経過</div>
          <div class="v">{recent.length ? `${(duration / 1000).toFixed(1)}s` : "—"}</div>
        </div>
      </div>
      <div class="section">
        <h3>解法ガイド</h3>
        <SolutionGuide />
      </div>
      <div class="section">
        <h3>操作</h3>
        <div class="btn-row">
          <button class="btn small" onClick={() => controller.clearMoves()}>
            手順をクリア
          </button>
          <button class="btn small" onClick={() => controller.resetToSolved()}>
            完成状態にリセット
          </button>
          <button class="btn small" onClick={() => controller.beginScan()}>
            再スキャン
          </button>
          <button class="btn small" onClick={() => setVideo(true)}>
            動画を解析
          </button>
        </div>
        {video && <VideoAnalysis mode="free" onClose={() => setVideo(false)} />}
      </div>
    </div>
  );
}

export function StartCard() {
  const camera = useStore(controller.store, (s) => s.camera);
  return (
    <div>
      <div class="status-banner">
        <strong>ArUco マーカーのキューブ</strong>
        色をマーカーの ID で判定するので、揃ったキューブならスキャンなしで始められます。崩れたキューブは 6 面をスキャンしてください。
      </div>
      <div class="btn-row">
        <button class="btn primary" disabled={camera !== "on"} onClick={() => controller.startFromSolved()}>
          揃った状態から開始
        </button>
        <button class="btn" disabled={camera !== "on"} onClick={() => controller.beginScan()}>
          6面スキャン
        </button>
      </div>
      {camera !== "on" && <p class="muted small">先にカメラを開始してください。カメラがなくても「デモで試す」で動きを確認できます。</p>}
      <div class="section">
        <h3>うまく追跡するコツ</h3>
        <ul class="small muted" style={{ paddingLeft: 18, margin: 0 }}>
          <li>カメラを少し上に置き、キューブの「正面」と「上面」の2面が映るようにする</li>
          <li>明るい場所で。強い反射や逆光は避ける</li>
          <li>キューブは画面の中央付近に。マーカーが小さすぎると読めません（マスの間隔が 40px 以上）</li>
          <li>最初はゆっくり（1秒に1〜2手）。慣れたら速く</li>
        </ul>
      </div>
    </div>
  );
}

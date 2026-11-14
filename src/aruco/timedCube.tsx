// 推定した手順を動かす 3D キューブ（描画はライブと同じ src/ui/cubeScene.ts）。
// time（実時間 ms）を親が進める（動画に合わせる・自前の再生ボタンで進める）。time までに回し始めた手を、実際の速さではなく
// 決まった速さ（1 手 TURN_MS、画面の時間。溜まっていれば速める）で 1 手ずつ回す: 実際の速さに合わせると、速い手は 1 フレームで
// 終わって回転が描かれないことがあった。戻るとき（動画を戻した）はすぐにその状態にする。
// pose（キューブ固定 → カメラの回転）を渡すと、カメラに映っているキューブと同じ向き（傾きにも追従）
import { useEffect, useRef, useState } from "preact/hooks";
import { Quaternion } from "three";
import { ORIENTATIONS, applyMove, solvedState, type CubeState } from "../cube/model";
import type { DecodedMove } from "../track/types";
import { CubeScene, approach, matToQuat } from "../ui/cubeScene";
import { moveAt, moveSpans } from "./timeline";

const TURN_MS = 220;

export function TimedCube3D({ moves, time, held, pose }: { moves: DecodedMove[]; time: number; held: boolean; pose?: number[] | null }) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<CubeScene | null>(null);
  const shownQ = useRef(new Quaternion());
  const target = useRef(new Quaternion());
  const count = useRef(0); // 回した（回している・待っている）手の数
  const states = useRef<CubeState[]>([solvedState()]);
  const starts = useRef<number[]>([]);

  useEffect(() => {
    const s = new CubeScene();
    scene.current = s;
    host.current!.appendChild(s.canvas);
    const ro = new ResizeObserver(() => {
      const r = host.current?.getBoundingClientRect();
      if (r) s.resize(r.width, r.height);
    });
    ro.observe(host.current!);
    s.onFrame = (_now, dt, root) => {
      const before = shownQ.current.clone();
      approach(shownQ.current, target.current, dt, 80);
      root.quaternion.copy(shownQ.current);
      // 回し終えた手の数（E2E が見る）
      if (host.current) host.current.dataset.done = String(Math.max(0, count.current) - s.waiting() - (s.turning() ? 1 : 0));
      return before.angleTo(shownQ.current) > 1e-4;
    };
    return () => {
      ro.disconnect();
      s.dispose();
      scene.current = null;
    };
  }, []);

  // 手順が変わったら、状態と手ごとの回し始めを作り直す
  const key = moves.map((m) => `${m.move}:${m.t0 ?? ""}:${m.t}`).join(",");
  useEffect(() => {
    const st = [solvedState()];
    for (const m of moves) st.push(applyMove(st[st.length - 1], m.move));
    states.current = st;
    starts.current = moveSpans(moves).map((x) => x.start);
    count.current = -1; // 次で合わせ直す
  }, [key]);

  useEffect(() => {
    const s = scene.current;
    if (!s) return;
    const want = moveAt(time, starts.current.map((x) => ({ start: x, end: x }))) + 1;
    if (count.current < 0 || want < count.current) {
      s.setState(states.current[want]);
      count.current = want;
    } else {
      for (let i = count.current; i < want; i++) s.enqueue(moves[i].move, s.waiting() > 1 ? TURN_MS / 2 : TURN_MS);
      count.current = want;
    }
    if (held && moves.length) {
      const o = moves[Math.max(0, want - 1)].orient;
      const M = ORIENTATIONS[o];
      // キューブ固定 → カメラ = 傾き R · 持ち方
      const RM = pose ? [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => pose[r * 3] * M[c] + pose[r * 3 + 1] * M[3 + c] + pose[r * 3 + 2] * M[6 + c])) : M;
      target.current = matToQuat(RM);
    } else target.current = new Quaternion();
    s.invalidate();
  }, [time, key, pose?.join(), held]);

  return <div class="cube3d live-cube" ref={host} />;
}

// 自前の再生ボタンで、手を等間隔（STEP_MS ごとに 1 手）に再生する（実際の速さ・間ではなく、どの手も同じ速さで見えるように）
const STEP_MS = 400;
export function TimedReplay({ moves }: { moves: DecodedMove[] }) {
  const even = moves.map((m, i) => ({ ...m, t0: i * STEP_MS, t: i * STEP_MS + TURN_MS }));
  const to = moves.length * STEP_MS;
  return <ReplayControls from={-STEP_MS} to={to} moves={even} />;
}

function ReplayControls({ from, to, moves }: { from: number; to: number; moves: DecodedMove[] }) {
  const [T, setT] = useState(to);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const tRef = useRef(T);
  tRef.current = T;
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let h = 0;
    const tick = (now: number) => {
      const next = tRef.current + (now - last) * speed;
      last = now;
      if (next >= to) {
        setT(to);
        setPlaying(false);
        return;
      }
      setT(next);
      h = requestAnimationFrame(tick);
    };
    h = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(h);
  }, [playing, speed, to]);
  const done = moves.filter((m) => m.t <= T).length;
  return (
    <div class="timed-replay">
      <TimedCube3D moves={moves} time={T} held={false} />
      <div class="btn-row">
        <button
          class="btn small"
          onClick={() => {
            if (!playing && T >= to - 1) setT(from);
            setPlaying(!playing);
          }}
        >
          {playing ? "⏸ 一時停止" : "▶ 再生"}
        </button>
        <button
          class="btn small"
          onClick={() => {
            setPlaying(false);
            setT(from);
          }}
        >
          ⏮ 最初へ
        </button>
        <select value={speed} onChange={(e) => setSpeed(Number((e.target as HTMLSelectElement).value))}>
          {[2, 1, 0.5].map((v) => (
            <option value={v}>{`${v}×`}</option>
          ))}
        </select>
      </div>
      <input
        type="range"
        min={from}
        max={to}
        step={1}
        value={T}
        onInput={(e) => {
          setPlaying(false);
          setT(Number((e.target as HTMLInputElement).value));
        }}
      />
      <div class="hint">
        {done} / {moves.length} 手（等間隔で再生）
      </div>
    </div>
  );
}

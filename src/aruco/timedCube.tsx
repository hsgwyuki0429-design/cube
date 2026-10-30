// 推定した手順を動かす 3D キューブ（cubing.js の <twisty-player> の再生位置を自前で進める）。
// time（実時間 ms）を親が進める（動画に合わせる・自前の再生ボタンで進める）。time までに回し始めた手を、実際の速さではなく
// 決まった速さ（1 手 TURN_MS、画面の時間）で 1 手ずつ回す: 実際の速さに合わせると、速い手は 1 フレームで終わって回転が
// 描かれないことがあった。たまっていれば速めるが、人が回るのを見て取れる MIN_TURN_MS より速くしない。
// pose（キューブ固定 → カメラの回転）を渡すと、カメラに映っているキューブと同じ向き（ジャイロのように傾きにも追従）
import type { TwistyPlayer } from "cubing/twisty";
import { useEffect, useRef, useState } from "preact/hooks";
import { Quaternion, type Object3D } from "three";
import { MOVE_NAMES, ORIENTATIONS } from "../cube/model";
import type { DecodedMove } from "../track/types";
import { matToQuat } from "../ui/Cube3D";
import { moveAt, moveSpans } from "./timeline";

const TURN_MS = 220;
const MIN_TURN_MS = 90;

interface Timing {
  starts: number[]; // 手ごとの回し始め（実時間 ms）
  pStart: number[];
  pDur: number[];
}

export function TimedCube3D({ moves, time, held, pose }: { moves: DecodedMove[]; time: number; held: boolean; pose?: number[] | null }) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<TwistyPlayer | null>(null);
  const puzzle = useRef<Object3D | null>(null);
  const timing = useRef<Timing | null>(null);
  const timeRef = useRef(time);
  const target = useRef(new Quaternion());
  const raf = useRef(0);
  const anim = useRef(0);
  const pos = useRef(0); // 表示している位置（手の番号 + 回した割合）
  const ready = useRef<Promise<void> | null>(null);
  timeRef.current = time;
  const gyro = held && !!pose;

  const render = async () => {
    const p = player.current;
    if (p) for (const v of await p.experimentalCurrentVantages()) v.scheduleRender();
  };

  // 向き（持ち方・カメラから見た傾き）へ滑らかに向ける
  const turnTo = (q: Quaternion) => {
    if (q.angleTo(target.current) < 1e-4) return;
    target.current = q;
    cancelAnimationFrame(raf.current);
    const step = () => {
      const obj = puzzle.current;
      if (!obj) return;
      obj.quaternion.slerp(target.current, gyro ? 0.35 : 0.25);
      void render();
      if (obj.quaternion.angleTo(target.current) > 0.002) raf.current = requestAnimationFrame(step);
      else obj.quaternion.copy(target.current);
    };
    raf.current = requestAnimationFrame(step);
  };

  const show = () => {
    const p = player.current;
    const tm = timing.current;
    if (!p || !tm) return;
    const i = Math.min(Math.floor(pos.current), tm.pStart.length);
    const ts = i >= tm.pStart.length ? (tm.pStart.length ? tm.pStart[i - 1] + tm.pDur[i - 1] : 0) : tm.pStart[i] + tm.pDur[i] * (pos.current - i);
    p.timestamp = ts as never; // MillisecondTimestamp（タグ付きの number）
  };

  // time までに回し始めた手の数まで、決まった速さで進める。戻るとき（動画を戻した）はすぐに戻す
  const advance = () => {
    const tm = timing.current;
    if (!tm) return;
    const want = moveAt(timeRef.current, tm.starts.map((s) => ({ start: s, end: s }))) + 1;
    if (want < pos.current) {
      pos.current = want;
      show();
      return;
    }
    if (anim.current || want <= pos.current) return;
    let last = performance.now();
    const step = (now: number) => {
      const goal = moveAt(timeRef.current, tm.starts.map((s) => ({ start: s, end: s }))) + 1;
      const backlog = goal - pos.current;
      const ms = Math.max(MIN_TURN_MS, TURN_MS / Math.max(1, backlog / 2));
      pos.current = Math.min(goal, pos.current + (now - last) / ms);
      last = now;
      show();
      if (pos.current < goal) anim.current = requestAnimationFrame(step);
      else anim.current = 0;
    };
    anim.current = requestAnimationFrame(step);
  };

  const apply = () => {
    advance();
    if (!held || !moves.length || !timing.current) return;
    const T = timeRef.current;
    const o = moves[Math.max(0, moveAt(T, timing.current.starts.map((s) => ({ start: s, end: s }))))].orient;
    const M = ORIENTATIONS[o];
    if (!pose) return turnTo(matToQuat(M));
    // キューブ固定 → カメラ = 傾き R · 持ち方
    const RM = [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => pose[r * 3] * M[c] + pose[r * 3 + 1] * M[3 + c] + pose[r * 3 + 2] * M[6 + c]));
    turnTo(matToQuat(RM));
  };

  useEffect(() => {
    let cancelled = false;
    ready.current = (async () => {
      const { TwistyPlayer } = await import("cubing/twisty");
      if (cancelled || !host.current) return;
      const p = new TwistyPlayer({
        puzzle: "3x3x3",
        visualization: "3D",
        controlPanel: "none",
        background: "none",
        hintFacelets: "none",
        backView: "none",
        experimentalDragInput: held ? "none" : "auto",
        // カメラの傾きに追従するときは正面から（カメラと同じ視点）
        cameraLatitude: gyro ? 0 : 28,
        cameraLongitude: gyro ? 0 : 32,
      });
      p.indexer = "simple"; // 手を 1 つずつ順に（同時に回す手をまとめない）
      host.current.appendChild(p);
      player.current = p;
      puzzle.current = (await p.experimentalCurrentThreeJSPuzzleObject()) as unknown as Object3D;
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf.current);
      cancelAnimationFrame(anim.current);
      anim.current = 0;
      player.current?.remove();
      player.current = null;
      puzzle.current = null;
    };
  }, []);

  useEffect(() => {
    const p = player.current;
    if (!p) return;
    p.cameraLatitude = gyro ? 0 : 28;
    p.cameraLongitude = gyro ? 0 : 32;
  }, [gyro]);

  // 手順が変わったら、3D 側の手ごとの位置と長さを読み直す
  const key = moves.map((m) => `${m.move}:${m.t0 ?? ""}:${m.t}`).join(",");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await ready.current;
      const p = player.current;
      if (cancelled || !p) return;
      p.alg = moves.map((m) => MOVE_NAMES[m.move]).join(" ");
      const idx = await p.experimentalModel.indexer.get();
      if (cancelled) return;
      const n = moves.length;
      cancelAnimationFrame(anim.current);
      anim.current = 0;
      timing.current = {
        starts: moveSpans(moves).map((s) => s.start),
        pStart: Array.from({ length: n }, (_, i) => idx.indexToMoveStartTimestamp(i as never)),
        pDur: Array.from({ length: n }, (_, i) => idx.moveDuration(i as never)),
      };
      pos.current = Math.min(pos.current, n);
      show();
      apply();
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  useEffect(apply, [time, pose?.join()]);

  return <div class="cube3d" ref={host} />;
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

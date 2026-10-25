// 推定した手順を、実際に回した速さと間で動かす 3D キューブ（cubing.js の <twisty-player> の再生位置を実時間から決める）。
// time（実時間 ms）を親が進める: 動画に合わせる・自前の再生ボタンで進める
import type { TwistyPlayer } from "cubing/twisty";
import { useEffect, useRef, useState } from "preact/hooks";
import { Quaternion, type Object3D } from "three";
import { MOVE_NAMES, ORIENTATIONS } from "../cube/model";
import type { DecodedMove } from "../track/types";
import { matToQuat } from "../ui/Cube3D";
import { type Span, moveAt, moveSpans, playerTimestamp } from "./timeline";

interface Timing {
  spans: Span[];
  pStart: number[];
  pDur: number[];
}

export function TimedCube3D({ moves, time, held }: { moves: DecodedMove[]; time: number; held: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<TwistyPlayer | null>(null);
  const puzzle = useRef<Object3D | null>(null);
  const timing = useRef<Timing | null>(null);
  const timeRef = useRef(time);
  const target = useRef(new Quaternion());
  const raf = useRef(0);
  const ready = useRef<Promise<void> | null>(null);
  timeRef.current = time;

  const render = async () => {
    const p = player.current;
    if (p) for (const v of await p.experimentalCurrentVantages()) v.scheduleRender();
  };

  // 持ち方（その手のときの姿勢）へ滑らかに向ける
  const turnTo = (q: Quaternion) => {
    if (q.angleTo(target.current) < 1e-4) return;
    target.current = q;
    cancelAnimationFrame(raf.current);
    const step = () => {
      const obj = puzzle.current;
      if (!obj) return;
      obj.quaternion.slerp(target.current, 0.25);
      void render();
      if (obj.quaternion.angleTo(target.current) > 0.002) raf.current = requestAnimationFrame(step);
      else obj.quaternion.copy(target.current);
    };
    raf.current = requestAnimationFrame(step);
  };

  const apply = () => {
    const p = player.current;
    const tm = timing.current;
    if (!p || !tm) return;
    const T = timeRef.current;
    p.timestamp = playerTimestamp(T, tm.spans, tm.pStart, tm.pDur) as never; // MillisecondTimestamp（タグ付きの number）
    if (held && moves.length) turnTo(matToQuat(ORIENTATIONS[moves[Math.max(0, moveAt(T, tm.spans))].orient]));
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
        cameraLatitude: 28,
        cameraLongitude: 32,
      });
      p.indexer = "simple"; // 手を 1 つずつ順に（同時に回す手をまとめない）
      host.current.appendChild(p);
      player.current = p;
      puzzle.current = (await p.experimentalCurrentThreeJSPuzzleObject()) as unknown as Object3D;
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf.current);
      player.current?.remove();
      player.current = null;
      puzzle.current = null;
    };
  }, []);

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
      timing.current = {
        spans: moveSpans(moves),
        pStart: Array.from({ length: n }, (_, i) => idx.indexToMoveStartTimestamp(i as never)),
        pDur: Array.from({ length: n }, (_, i) => idx.moveDuration(i as never)),
      };
      apply();
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  useEffect(apply, [time]);

  return <div class="cube3d" ref={host} />;
}

// 自前の再生ボタンで、実際の速さ（と 1/2・1/4 の速さ）で再生する
export function TimedReplay({ moves }: { moves: DecodedMove[] }) {
  const spans = moveSpans(moves);
  const from = (spans[0]?.start ?? 0) - 400;
  const to = (spans[spans.length - 1]?.end ?? 0) + 400;
  return <ReplayControls from={from} to={to} moves={moves} first={spans[0]?.start ?? 0} last={spans[spans.length - 1]?.end ?? 0} />;
}

function ReplayControls({ from, to, moves, first, last }: { from: number; to: number; moves: DecodedMove[]; first: number; last: number }) {
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
          {[1, 0.5, 0.25].map((v) => (
            <option value={v}>{v === 1 ? "実際の速さ" : `${v}×`}</option>
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
        {(Math.min(Math.max(T - first, 0), last - first) / 1000).toFixed(2)} / {((last - first) / 1000).toFixed(2)} 秒・{done} / {moves.length} 手
      </div>
    </div>
  );
}

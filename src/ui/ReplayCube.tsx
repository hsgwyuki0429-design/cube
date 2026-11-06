// 記録の詳しい画面の 3D: 自分の解き方を、回した間隔のとおりに（ゆっくり）再生する。1 手を回す描画の速さは一定（1 手 約 500ms）で、
// 手と手の間だけを実際の間隔 × SLOW にする（速く続けて回した所は詰まって、間の空いた所は空いて見える）。キューブの向きは、その手を
// 回したときにカメラから見えていた向き（SolveMove.o）に合わせる。指でドラッグしている間だけ指のとおりに向きを変え、離すとカメラから
// 見えていた向きへ戻る
import { useEffect, useRef, useState } from "preact/hooks";
import { Matrix4, type Object3D, Quaternion, Vector3 } from "three";
import type { TwistyPlayer } from "cubing/twisty";
import { MOVE_NAMES, ORIENTATIONS } from "../cube/model";
import { PLAYER_BASE } from "./Cube3D";

export interface ReplayMove {
  move: number; // キューブ固定の手
  s: number; // 回し始め（ms、計測開始から）
  orient: number | null; // そのときカメラから見えていた向き（キューブ固定 → カメラ）
}

const TURN_MS = 500; // 1 手を回す描画の長さ（cubing.js の tempoScale 1）
const GAP_MS = 60; // 回し終えてから次の手までの最小の間（続けて回した手がつながって見えないように）
// 実際の間隔に掛ける倍率: 平均の間隔が 1 手 約 700ms になるように（1〜8 倍）
const slowOf = (moves: ReplayMove[]) => {
  if (moves.length < 2) return 4;
  const span = moves[moves.length - 1].s - moves[0].s;
  return Math.min(8, Math.max(1, 700 / Math.max(1, span / (moves.length - 1))));
};

// 少し上と右から見た向き（3 面が見える。ライブの 3D の姿勢が届かないときと同じ）
const TILT = new Quaternion()
  .setFromAxisAngle(new Vector3(0, 1, 0), (-30 * Math.PI) / 180)
  .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (25 * Math.PI) / 180));
const quatOf = (o: number | null) => {
  const q = new Quaternion();
  if (o !== null) {
    const m = ORIENTATIONS[o];
    q.setFromRotationMatrix(new Matrix4().set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1));
  }
  return new Quaternion().multiplyQuaternions(TILT, q);
};

export function ReplayCube(props: { setupAlg: string; moves: ReplayMove[]; from: number }) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<TwistyPlayer | null>(null);
  const obj = useRef<Object3D | null>(null);
  const timers = useRef<number[]>([]);
  const raf = useRef(0);
  const target = useRef(new Quaternion());
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(props.from);
  const slow = slowOf(props.moves);

  const render = async () => {
    for (const v of (await player.current?.experimentalCurrentVantages()) ?? []) v.scheduleRender();
  };
  // 向きをなめらかに追う
  const turnTo = (o: number | null) => {
    target.current = quatOf(o);
    cancelAnimationFrame(raf.current);
    let last = performance.now();
    const step = (now: number) => {
      const q = obj.current?.quaternion;
      if (!q) return;
      const k = 1 - Math.exp(-(now - last) / 120);
      last = now;
      q.slerp(target.current, k);
      render();
      if (q.angleTo(target.current) > 0.002) raf.current = requestAnimationFrame(step);
      else {
        q.copy(target.current);
        render();
      }
    };
    raf.current = requestAnimationFrame(step);
  };
  const stop = () => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
    setPlaying(false);
  };
  // k 手目の前の状態にする（回さずに）
  const jump = (k: number) => {
    const p = player.current;
    if (!p) return;
    stop();
    p.experimentalSetupAlg = props.setupAlg;
    p.alg = props.moves
      .slice(0, k)
      .map((m) => MOVE_NAMES[m.move])
      .join(" ");
    p.jumpToEnd();
    setAt(k);
    turnTo(props.moves[Math.min(k, props.moves.length - 1)]?.orient ?? null);
  };
  // k 手目から、回した間隔のとおりに再生する
  const play = (k: number) => {
    const p = player.current;
    if (!p) return;
    jump(k >= props.moves.length ? 0 : k);
    const from = k >= props.moves.length ? 0 : k;
    setPlaying(true);
    p.tempoScale = 1;
    let free = 0; // 前の手を回し終える時刻（再生を始めてから）
    let prevS = props.moves[from]?.s ?? 0;
    let at0 = 0;
    for (let i = from; i < props.moves.length; i++) {
      const m = props.moves[i];
      const when = Math.max(at0 + (m.s - prevS) * slow, i === from ? 0 : free + GAP_MS);
      at0 = when;
      prevS = m.s;
      free = when + TURN_MS;
      timers.current.push(
        window.setTimeout(() => {
          turnTo(m.orient);
          player.current?.experimentalAddMove(MOVE_NAMES[m.move]);
          setAt(i + 1);
        }, when),
      );
    }
    timers.current.push(window.setTimeout(() => setPlaying(false), free));
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { TwistyPlayer } = await import("cubing/twisty");
      if (cancelled || !host.current) return;
      const p = new TwistyPlayer({ ...PLAYER_BASE, controlPanel: "none", experimentalDragInput: "auto", tempoScale: 1, cameraLatitude: 0, cameraLongitude: 0 });
      host.current.appendChild(p);
      player.current = p;
      obj.current = (await p.experimentalCurrentThreeJSPuzzleObject()) as unknown as Object3D;
      setReady(true);
    })();
    return () => {
      cancelled = true;
      stop();
      cancelAnimationFrame(raf.current);
      player.current?.remove();
      player.current = null;
      obj.current = null;
    };
  }, []);

  // 手を押したとき・記録が変わったとき: その手の前から再生
  useEffect(() => {
    if (ready) play(props.from);
  }, [ready, props.from, props.setupAlg, props.moves.length]);

  // ドラッグを離したら、カメラ（見る位置）を真正面に戻す（向きはカメラから見えていた向きのまま）
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let anim = 0;
    const back = () => {
      const scene = (player.current as unknown as { experimentalModel?: { twistySceneModel?: { orbitCoordinates: { get(): Promise<{ latitude: number; longitude: number }> }; orbitCoordinatesRequest: { set(v: { latitude: number; longitude: number }): void } } } })?.experimentalModel?.twistySceneModel;
      if (!scene) return;
      scene.orbitCoordinates.get().then((c) => {
        const t0 = performance.now();
        cancelAnimationFrame(anim);
        const step = (now: number) => {
          const k = Math.min(1, (now - t0) / 300);
          const e = 1 - (1 - k) ** 3;
          scene.orbitCoordinatesRequest.set({ latitude: c.latitude * (1 - e), longitude: c.longitude * (1 - e) });
          if (k < 1) anim = requestAnimationFrame(step);
        };
        anim = requestAnimationFrame(step);
      });
    };
    const down = () => cancelAnimationFrame(anim);
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", back);
    window.addEventListener("pointercancel", back);
    return () => {
      cancelAnimationFrame(anim);
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", back);
      window.removeEventListener("pointercancel", back);
    };
  }, []);

  const n = props.moves.length;
  return (
    <div class="replay-cube">
      <div class="cube3d" ref={host} />
      <div class="replay-bar">
        <button class="btn ghost small" onClick={() => jump(0)}>
          最初へ
        </button>
        <button class="btn small" onClick={() => (playing ? stop() : play(at))}>
          {playing ? "止める" : "再生"}
        </button>
        <span class="muted small">
          {Math.min(at, n)} / {n} 手・実際の間隔の {slow.toFixed(1)} 倍（1 手の回転の速さは一定）
        </span>
      </div>
    </div>
  );
}

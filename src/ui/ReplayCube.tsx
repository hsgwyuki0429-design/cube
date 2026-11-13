// 記録の詳しい画面の 3D: 自分の解き方を、実際と同じ速さで再生する。手を回し始める時刻・1 手を回す長さ（回し始め〜回し終わり）とも
// 計測した時刻のとおり（速さを 1/2・1/4・1/8 にしても、全部を同じ割合で遅くする）。
// 見え方は 3 通り（`ReplayView`）:
// - camera: 計測中にカメラから見えていた向き（`Solve.poses`）。ライブの 3D と同じく、鏡像のプレビューなら鏡像、自分視点なら y2
// - fixed: 白上・緑前を少し上と右から見た定点
// - down: クロスの面を下にした定点。「F2L に合わせる」がオンなら、F2L の間は次に入るスロットが、入れたときにカメラから見て
//   あった側（手前の右・手前の左・奥の右・奥の左）に来るように縦の軸で 90° ごとに回す（手前で入れたペアは手前に、奥で入れた
//   ペア（裏 F2L）は奥に）
// 「次の F2L を光らせる」は、F2L の途中で次に入るペアとクロス・入ったスロットのほかを暗くする（どの見え方でも）。
// 指でドラッグしている間だけ指のとおりに向きを変え、離すと戻る
import { useEffect, useRef, useState } from "preact/hooks";
import { type Object3D, Quaternion, Vector3 } from "three";
import type { TwistyPlayer } from "cubing/twisty";
import { type F2LStep, f2lMask, slotDir } from "../cube/f2l";
import { type Mat3, MOVE_NAMES, ORIENTATIONS, ROTATION, apply, mul } from "../cube/model";
import { PLAYER_BASE, matToQuat } from "./Cube3D";

export interface ReplayMove {
  move: number; // キューブ固定の手
  s: number; // 回し始め（ms、計測開始から）
  t: number; // 回し終わり
  orient: number | null; // そのときカメラから見えていた向き（キューブ固定 → カメラ）
}

export type ReplayView = "camera" | "fixed" | "down";

const CATCH_UP_MS = 500; // cubing.js で足した手を回す長さ（tempoScale 1 のとき）
const MIN_TURN_MS = 60; // 回し終わりが分からない・短すぎる手の描画の長さの下限（実際の時間）
const UNKNOWN_TURN_MS = 150;

// 少し上と右から見た向き（3 面が見える）
const TILT = new Quaternion()
  .setFromAxisAngle(new Vector3(0, 1, 0), (-30 * Math.PI) / 180)
  .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (25 * Math.PI) / 180));
const tiltOf = (m: Mat3) => new Quaternion().multiplyQuaternions(TILT, matToQuat(m));

// 記録した向き（計測開始からの ms, x, y, z, w）をならす: 1 つだけ大きく跳ねた向き（持ち替えの読み違い）は捨て、前後 ±150ms を平均する
type Pose = { t: number; q: Quaternion };
function smoothPoses(raw: number[][]): Pose[] {
  const ps = raw.map((p) => ({ t: p[0], q: new Quaternion(p[1], p[2], p[3], p[4]).normalize() }));
  const kept = ps.filter((p, i) => {
    const a = ps[i - 1];
    const b = ps[i + 1];
    if (!a || !b) return true;
    return !(p.q.angleTo(a.q) > 1 && p.q.angleTo(b.q) > 1 && a.q.angleTo(b.q) < 0.6);
  });
  return kept.map((p) => {
    let x = 0, y = 0, z = 0, w = 0, n = 0;
    for (const o of kept) {
      if (Math.abs(o.t - p.t) > 150 || o.q.angleTo(p.q) > 0.6) continue;
      const s = o.q.dot(p.q) < 0 ? -1 : 1;
      const k = 1 - Math.abs(o.t - p.t) / 200;
      x += s * k * o.q.x;
      y += s * k * o.q.y;
      z += s * k * o.q.z;
      w += s * k * o.q.w;
      n++;
    }
    return { t: p.t, q: n ? new Quaternion(x, y, z, w).normalize() : p.q };
  });
}

// 時刻 t の向き（前後を球面補間。0.6 秒以上あいていたら前の向き）
function poseAt(poses: Pose[], t: number): Quaternion | null {
  if (!poses.length) return null;
  if (t <= poses[0].t) return poses[0].q.clone();
  const last = poses[poses.length - 1];
  if (t >= last.t) return last.q.clone();
  let lo = 0;
  let hi = poses.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (poses[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = poses[lo];
  const b = poses[hi];
  return b.t - a.t > 600 ? a.q.clone() : a.q.clone().slerp(b.q, (t - a.t) / (b.t - a.t));
}

const SPEEDS: { label: string; slow: number }[] = [
  { label: "等倍", slow: 1 },
  { label: "1/2", slow: 2 },
  { label: "1/4", slow: 4 },
  { label: "1/8", slow: 8 },
];

// 見え方・スイッチは端末に覚える（読めなくても既定で動く）
function usePref<T extends string | boolean>(key: string, fallback: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(`cubevision.replay.${key}`);
      return s === null ? fallback : (JSON.parse(s) as T);
    } catch {
      return fallback;
    }
  });
  const set = (x: T) => {
    setV(x);
    try {
      localStorage.setItem(`cubevision.replay.${key}`, JSON.stringify(x));
    } catch {
      // 覚えられなくても表示はできる
    }
  };
  return [v, set];
}

const Y90 = ROTATION.y;
const yaw = (k: number): Mat3 => {
  let m: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let i = 0; i < ((k % 4) + 4) % 4; i++) m = mul(Y90, m);
  return m;
};

export interface ReplayCubeProps {
  setupAlg: string;
  moves: ReplayMove[];
  from: number;
  poses?: number[][];
  onTurn?: () => void;
  mirror?: boolean; // camera の見え方で鏡像にする（ライブの 3D と同じ）
  userView?: boolean; // camera の見え方で自分視点（y2）
  solverFlip?: boolean; // 解いた人はカメラの反対側から見ていた（インカメラ）: 手前・奥と左右をカメラから見たのと逆にする
  downOrient: number; // クロスの面を下にした持ち方（キューブ固定 → 表示）
  downLabel: string; // 「白面下」など
  crossFace: number;
  plan: (F2LStep | null)[]; // k 手回した後の次に入るスロット（f2lPlan）
}

export function ReplayCube(props: ReplayCubeProps) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<TwistyPlayer | null>(null);
  const obj = useRef<Object3D | null>(null);
  const loop = useRef(0);
  const aim = useRef(0);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(props.from);
  const [speed, setSpeed] = useState(0);
  const [view, setView] = usePref<ReplayView>("view", "camera");
  const [follow, setFollow] = usePref<boolean>("f2lFollow", true);
  const [glow, setGlow] = usePref<boolean>("f2lGlow", false);
  const slow = SPEEDS[speed].slow;
  // 再生中のフレームからも、いまの見え方・スイッチを読む
  const opts = useRef({ view, follow, glow });
  opts.current = { view, follow, glow };
  const poses = useRef<Pose[]>([]);
  const hasPoses = !!props.poses?.length;
  const atRef = useRef(at);
  atRef.current = at;

  useEffect(() => {
    poses.current = smoothPoses(props.poses ?? []);
  }, [props.poses]);

  const render = async () => {
    for (const v of (await player.current?.experimentalCurrentVantages()) ?? []) v.scheduleRender();
  };

  // 実際の時刻 t の、カメラから見えていた向き（記録がなければ手ごとの向き）
  const cameraQuat = (t: number, k: number): Quaternion => {
    const q = poseAt(poses.current, t);
    const base = q ? q : tiltOf(ORIENTATIONS[props.moves[Math.min(k, props.moves.length - 1)]?.orient ?? 0]);
    return props.userView ? new Quaternion().multiplyQuaternions(matToQuat(mul(ROTATION.y, ROTATION.y)), base) : base;
  };

  // F2L に合わせる: 次に入るスロットが、入れた手のときにカメラから見てあった側（手前・奥 × 右・左）に来るように縦の軸で回す
  const downMatrix = (k: number): Mat3 => {
    const hold = ORIENTATIONS[props.downOrient];
    const step = props.plan[k];
    if (!opts.current.follow || !step) return hold;
    const done = props.moves[step.doneAt - 1];
    const dir = slotDir(step.slot);
    // 入れたときのカメラから見た向き（記録の向き → 手ごとの向き → 分からなければ手前の右）
    let seen: number[] | null = null;
    const q = done ? poseAt(poses.current, (done.s + done.t) / 2) : null;
    if (q) {
      const v = new Vector3(dir[0], dir[1], dir[2]).applyQuaternion(q);
      seen = [v.x, v.y, v.z];
    } else if (done?.orient !== null && done?.orient !== undefined) seen = apply(ORIENTATIONS[done.orient], dir);
    if (seen && props.solverFlip) seen = [-seen[0], seen[1], -seen[2]];
    const sx = seen ? (seen[0] >= 0 ? 1 : -1) : 1;
    const sz = seen ? (seen[2] >= -0.15 ? 1 : -1) : 1;
    for (let r = 0; r < 4; r++) {
      const m = mul(yaw(r), hold);
      const w = apply(m, dir);
      if (Math.sign(w[0]) === sx && Math.sign(w[2]) === sz) return m;
    }
    return hold;
  };

  // k 手回した後・実際の時刻 t の表示の向き
  const targetQuat = (k: number, t: number): Quaternion => {
    if (opts.current.view === "camera") return cameraQuat(t, k);
    if (opts.current.view === "fixed") return TILT.clone();
    return tiltOf(downMatrix(k));
  };

  // 定点の向きは、変わるときだけなめらかに追う（camera は毎フレーム記録どおり）
  const easeTo = (q: Quaternion) => {
    cancelAnimationFrame(aim.current);
    let last = performance.now();
    const step = (now: number) => {
      const cur = obj.current?.quaternion;
      if (!cur) return;
      const k = 1 - Math.exp(-(now - last) / 140);
      last = now;
      cur.slerp(q, k);
      render();
      if (cur.angleTo(q) > 0.002) aim.current = requestAnimationFrame(step);
      else {
        cur.copy(q);
        render();
      }
    };
    aim.current = requestAnimationFrame(step);
  };

  const setMask = (k: number) => {
    const p = player.current as unknown as { experimentalStickeringMaskOrbits: string | null } | null;
    if (!p) return;
    p.experimentalStickeringMaskOrbits = opts.current.glow ? f2lMask(props.crossFace, props.plan[k] ?? null) : null;
  };

  const showAt = (k: number, t: number, instant: boolean) => {
    setMask(k);
    const q = targetQuat(k, t);
    if (opts.current.view === "camera" || instant) {
      cancelAnimationFrame(aim.current);
      obj.current?.quaternion.copy(q);
      render();
    } else easeTo(q);
  };

  const stop = () => {
    cancelAnimationFrame(loop.current);
    setPlaying(false);
  };

  const startOf = (k: number) => props.moves[Math.min(k, props.moves.length - 1)]?.s ?? 0;

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
    showAt(k, startOf(k), true);
  };

  // k 手目から、実際と同じ時刻で再生する（速さを変えたら全部を同じ割合で遅く）
  const play = (k0: number) => {
    const p = player.current;
    if (!p) return;
    const from = k0 >= props.moves.length ? 0 : k0;
    jump(from);
    if (!props.moves.length) return;
    setPlaying(true);
    // 最初の手は少し待ってから（いきなり回り始めないように）
    const real0 = startOf(from) - 300;
    const t0 = performance.now();
    const end = props.moves[props.moves.length - 1].t + 400;
    let next = from;
    const step = (now: number) => {
      const real = real0 + (now - t0) / slow;
      while (next < props.moves.length && props.moves[next].s <= real) {
        const m = props.moves[next];
        const dur = (m.t > m.s ? Math.max(MIN_TURN_MS, m.t - m.s) : UNKNOWN_TURN_MS) * slow;
        p.tempoScale = CATCH_UP_MS / dur;
        p.experimentalAddMove(MOVE_NAMES[m.move]);
        props.onTurn?.();
        next++;
        setAt(next);
        if (opts.current.view !== "camera") showAt(next, real, false);
      }
      if (opts.current.view === "camera") showAt(next, real, true);
      if (real < end) loop.current = requestAnimationFrame(step);
      else setPlaying(false);
    };
    loop.current = requestAnimationFrame(step);
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
      cancelAnimationFrame(loop.current);
      cancelAnimationFrame(aim.current);
      player.current?.remove();
      player.current = null;
      obj.current = null;
    };
  }, []);

  // 手を押したとき・記録・速さが変わったとき: その手の前から再生
  useEffect(() => {
    if (ready) play(props.from);
  }, [ready, props.from, props.setupAlg, props.moves.length, speed]);

  // 見え方・スイッチを変えたら、止まっていればその場で向きと光り方だけ変える（再生中は次のフレームから）
  useEffect(() => {
    if (ready && !playing) showAt(atRef.current, startOf(atRef.current), false);
    if (ready && playing) setMask(atRef.current);
  }, [view, follow, glow]);

  // ドラッグを離したら、カメラ（見る位置）を真正面に戻す
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
  const mirrored = view === "camera" && !!props.mirror;
  const views: { id: ReplayView; label: string }[] = [
    { id: "camera", label: hasPoses ? "カメラと同じ" : "カメラの向き" },
    { id: "down", label: props.downLabel },
    { id: "fixed", label: "定点（白上）" },
  ];
  return (
    <div class="replay-cube">
      <div class={`cube3d${mirrored ? " mirrored" : ""}`} ref={host} />
      <div class="replay-bar">
        <button class="btn ghost small" onClick={() => jump(0)}>
          最初へ
        </button>
        <button class="btn small" onClick={() => (playing ? stop() : play(at))}>
          {playing ? "止める" : "再生"}
        </button>
        <select class="small" value={speed} onChange={(e) => setSpeed(Number((e.target as HTMLSelectElement).value))} aria-label="再生の速さ">
          {SPEEDS.map((x, i) => (
            <option key={x.label} value={i}>
              {x.label}
            </option>
          ))}
        </select>
        <span class="muted small">
          {Math.min(at, n)} / {n} 手
        </span>
      </div>
      <div class="replay-views" role="radiogroup" aria-label="見え方">
        {views.map((v) => (
          <button key={v.id} role="radio" aria-checked={view === v.id} class="seg-btn" onClick={() => setView(v.id)}>
            {v.label}
          </button>
        ))}
      </div>
      <div class="replay-toggles">
        {view === "down" && (
          <label class="switch">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow((e.target as HTMLInputElement).checked)} />
            <span>F2L に合わせて回す</span>
          </label>
        )}
        <label class="switch">
          <input type="checkbox" checked={glow} onChange={(e) => setGlow((e.target as HTMLInputElement).checked)} />
          <span>次の F2L を光らせる</span>
        </label>
      </div>
    </div>
  );
}

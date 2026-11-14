// 記録の詳しい画面の 3D: 自分の解き方を、実際と同じ速さで再生する（描画はライブと同じ src/ui/cubeScene.ts）。手を回し始める時刻・
// 1 手を回す長さとも計測した時刻のとおり（速さを 1/2・1/4 にしても、全部を同じ割合で遅くする）。ただし 1 手の描画は MIN_TURN_MS より
// 短くしない（実際の速さ 1 手 0.1 秒では回転が目で追えない。遅れは手の間の止まりで取り戻す）。回した手の表記を 3D の上に大きく出す。
// 見え方は 3 通り（`ReplayView`）。どれも少し上・右から見下ろす目線で描く:
// - camera: 計測中にカメラから見えていた向き（`Solve.poses`）。ライブの 3D と同じく自分の目線（インカメラなら y2）で、傾きは弱めて見せる
// - fixed: 白上・緑前の定点
// - down: クロスの面を下にした定点。「F2L に合わせる」がオンなら、F2L の間は次に入るスロットが、入れたときにカメラから見て
//   あった側（手前の右・手前の左・奥の右・奥の左）に来るように縦の軸で 90° ごとに回す（手前で入れたペアは手前に、奥で入れた
//   ペア（裏 F2L）は奥に）。クロス・OLL・PLL の間はカメラの方を向いていた面を前に
// 「次の F2L を光らせる」は、F2L の途中で次に入るペアとクロス・入ったスロットのほかを暗くする（どの見え方でも）。
// 指でドラッグしている間だけ指のとおりに向きを変え、離すと戻る。simple（X クロスの最短など）は等間隔に回す定点だけ
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Quaternion, Vector3 } from "three";
import { type F2LStep, f2lLook, slotDir } from "../cube/f2l";
import { type CubeState, type Mat3, MOVE_NAMES, NORMAL, OPPOSITE, ORIENTATIONS, ROTATION, apply, applyMove, mul, parseMoves, solvedState } from "../cube/model";
import { CubeScene, approach, damped, matToQuat } from "./cubeScene";

export interface ReplayMove {
  move: number; // キューブ固定の手
  s: number; // 回し始め（ms、計測開始から）
  t: number; // 回し終わり
  orient: number | null; // そのときカメラから見えていた向き（キューブ固定 → カメラ）
}

export type ReplayView = "camera" | "fixed" | "down";

const MIN_TURN_MS = 200; // 1 手の描画の長さの下限（画面の時間）
const GAP_MS = 40; // 手と手の間の最小の止まり
const UNKNOWN_TURN_MS = 150; // 回し終わりが分からない手の長さ（実際の時間）
const TILT_GAIN = 0.65; // camera の見え方で、映った傾きをどれだけ移すか（ライブと同じ）
const Y2 = matToQuat(mul(ROTATION.y, ROTATION.y));

// 記録した向き（計測開始からの ms, x, y, z, w）をならす: 1 つだけ大きく跳ねた向き（持ち替えの読み違い）は捨て、前後 ±250ms を平均する
// （細かく揺れると、層の回転よりキューブ全体の揺れが目に入って回転が見づらかった）
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
      if (Math.abs(o.t - p.t) > 250 || o.q.angleTo(p.q) > 0.6) continue;
      const s = o.q.dot(p.q) < 0 ? -1 : 1;
      const k = 1 - Math.abs(o.t - p.t) / 300;
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
  userEye?: boolean; // camera の見え方で自分の側から見る（インカメラ: y2。ライブの 3D と同じ）
  solverFlip?: boolean; // 解いた人はカメラの反対側から見ていた（インカメラ）: 手前・奥と左右をカメラから見たのと逆にする
  downOrient: number; // クロスの面を下にした持ち方（キューブ固定 → 表示）
  downLabel: string; // 「白面下」など
  crossFace: number;
  plan: (F2LStep | null)[]; // k 手回した後の次に入るスロット（f2lPlan）
  labels: string[]; // 手ごとの表記（いま回した手を 3D の上に大きく出す）
  simple?: boolean; // 見え方・スイッチを出さず、クロスの面を下にした定点で再生する
}

interface Playback {
  t0: number;
  from: number;
  next: number;
  sched: { at: number; len: number; real: number }[];
  real0: number;
  end: number;
}

export function ReplayCube(props: ReplayCubeProps) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<CubeScene | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(props.from);
  const [speed, setSpeed] = useState(0);
  const [prefView, setView] = usePref<ReplayView>("view", "camera");
  const [follow, setFollow] = usePref<boolean>("f2lFollow", true);
  const [glow, setGlow] = usePref<boolean>("f2lGlow", false);
  const [shown, setShown] = useState<{ i: number; label: string } | null>(null);
  const view: ReplayView = props.simple ? "down" : prefView;
  const slow = SPEEDS[speed].slow;
  // 描画のループからも、いまの見え方・スイッチを読む
  const opts = useRef({ view, follow: follow && !props.simple, glow: glow && !props.simple });
  opts.current = { view, follow: follow && !props.simple, glow: glow && !props.simple };
  const poses = useRef<Pose[]>([]);
  const hasPoses = !!props.poses?.length;
  const atRef = useRef(at);
  atRef.current = at;
  const pb = useRef<Playback | null>(null);
  const shownQ = useRef(new Quaternion());
  const snapNext = useRef(true);
  const drag = useRef({ on: false, x: 0, y: 0, q: new Quaternion() });
  const propsRef = useRef(props);
  propsRef.current = props;

  // k 手回した後の状態
  const states = useMemo(() => {
    let s: CubeState = solvedState();
    try {
      for (const m of parseMoves(props.setupAlg)) s = applyMove(s, m);
    } catch {
      // 読めないスクランブルは揃った状態から
    }
    const out = [s];
    for (const m of props.moves) out.push(applyMove(out[out.length - 1], m.move));
    return out;
  }, [props.setupAlg, props.moves.map((m) => m.move).join()]);
  const statesRef = useRef(states);
  statesRef.current = states;

  useEffect(() => {
    poses.current = smoothPoses(props.poses ?? []);
  }, [props.poses]);

  // 実際の時刻 t の、カメラから見えていた向き（記録がなければ手ごとの向き）。傾きは弱め、自分の目線に直す
  const cameraQuat = (t: number, k: number): Quaternion => {
    const p = propsRef.current;
    const q = poseAt(poses.current, t);
    const base = q ? damped(q, TILT_GAIN, ORIENTATIONS) : matToQuat(ORIENTATIONS[p.moves[Math.min(k, p.moves.length - 1)]?.orient ?? 0]);
    return p.userEye ? base.premultiply(Y2) : base;
  };

  // カメラの方を向いていた側面（クロスの面とその反対を除く）を前にする（クロス・OLL・PLL の間）。自分の目線なら反対側
  const cameraFront = (k: number, t: number, hold: Mat3): Mat3 => {
    const p = propsRef.current;
    const q = poseAt(poses.current, t);
    const o = p.moves[Math.min(k, p.moves.length - 1)]?.orient;
    if (!q && (o === null || o === undefined)) return hold;
    const toCam = (v: readonly number[]) => (q ? new Vector3(v[0], v[1], v[2]).applyQuaternion(q).z : apply(ORIENTATIONS[o!], [v[0], v[1], v[2]])[2]);
    const sides = [0, 1, 2, 3, 4, 5].filter((f) => f !== p.crossFace && f !== OPPOSITE[p.crossFace]);
    const sign = p.userEye ? -1 : 1;
    const front = sides.reduce((best, f) => (sign * toCam(NORMAL[f]) > sign * toCam(NORMAL[best]) ? f : best), sides[0]);
    for (let r = 0; r < 4; r++) {
      const m = mul(yaw(r), hold);
      if (apply(m, NORMAL[front])[2] > 0.5) return m;
    }
    return hold;
  };

  // F2L に合わせる: 次に入るスロットが、入れた手のときにカメラから見てあった側（手前・奥 × 右・左）に来るように縦の軸で回す。
  // F2L の前後（クロス・OLL・PLL）はカメラの方を向いていた面を前に
  const downMatrix = (k: number, t: number): Mat3 => {
    const p = propsRef.current;
    const hold = ORIENTATIONS[p.downOrient];
    const step = p.plan[k];
    if (!opts.current.follow) return hold;
    if (!step) return cameraFront(k, t, hold);
    const done = p.moves[step.doneAt - 1];
    const dir = slotDir(step.slot);
    let seen: number[] | null = null;
    const q = done ? poseAt(poses.current, (done.s + done.t) / 2) : null;
    if (q) {
      const v = new Vector3(dir[0], dir[1], dir[2]).applyQuaternion(q);
      seen = [v.x, v.y, v.z];
    } else if (done?.orient !== null && done?.orient !== undefined) seen = apply(ORIENTATIONS[done.orient], dir);
    if (seen && p.solverFlip) seen = [-seen[0], seen[1], -seen[2]];
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
    if (opts.current.view === "fixed") return new Quaternion();
    return matToQuat(downMatrix(k, t));
  };

  const setMask = (k: number) => {
    const p = propsRef.current;
    scene.current?.setMask(opts.current.glow ? f2lLook(p.crossFace, p.plan[k] ?? null) : null);
  };

  const startOf = (k: number) => {
    const ms = propsRef.current.moves;
    return ms[Math.min(k, ms.length - 1)]?.s ?? 0;
  };

  const stop = () => {
    pb.current = null;
    setPlaying(false);
  };

  // k 手目の前の状態にする（回さずに）
  const jump = (k: number) => {
    stop();
    scene.current?.setState(statesRef.current[k]);
    setAt(k);
    setMask(k);
    snapNext.current = true;
  };

  // k 手目から、実際と同じ時刻で再生する（速さを変えたら全部を同じ割合で遅く）。1 手の描画は MIN_TURN_MS より短くせず、
  // 次の手はその後に（向きの記録は再生の時刻 → 実際の時刻に直して合わせる）
  const play = (k0: number) => {
    const ms = propsRef.current.moves;
    const from = k0 >= ms.length ? 0 : k0;
    jump(from);
    if (!ms.length) return;
    setPlaying(true);
    const real0 = startOf(from) - 350; // 最初の手は少し待ってから
    const sched: Playback["sched"] = [];
    let prevEnd = -Infinity;
    for (let i = from; i < ms.length; i++) {
      const m = ms[i];
      const len = Math.max(MIN_TURN_MS, (m.t > m.s ? m.t - m.s : UNKNOWN_TURN_MS) * slow);
      const at = Math.max((m.s - real0) * slow, prevEnd + GAP_MS);
      sched.push({ at, len, real: m.s });
      prevEnd = at + len;
    }
    pb.current = { t0: performance.now(), from, next: 0, sched, real0, end: prevEnd + 500 };
  };

  // 再生の時刻 tp の実際の時刻（遅れている間は次の手の回し始めで待つ）
  const realAt = (p: Playback, tp: number) => {
    const { sched } = p;
    let j = -1;
    while (j + 1 < sched.length && sched[j + 1].at <= tp) j++;
    if (j < 0) return Math.min(p.real0 + tp / slowRef.current, sched[0].real);
    const r = sched[j].real + (tp - sched[j].at) / slowRef.current;
    return j + 1 < sched.length ? Math.min(r, sched[j + 1].real) : r;
  };
  const slowRef = useRef(slow);
  slowRef.current = slow;

  useEffect(() => {
    const s = new CubeScene();
    scene.current = s;
    host.current!.appendChild(s.canvas);
    const ro = new ResizeObserver(() => {
      const r = host.current?.getBoundingClientRect();
      if (r) s.resize(r.width, r.height);
    });
    ro.observe(host.current!);
    s.onFrame = (now, dt, root) => {
      // 再生を進める
      const p = pb.current;
      let k = atRef.current;
      let real = startOf(k);
      if (p) {
        const tp = now - p.t0;
        while (p.next < p.sched.length && p.sched[p.next].at <= tp) {
          const i = p.from + p.next;
          const m = propsRef.current.moves[i];
          s.enqueue(m.move, p.sched[p.next].len);
          propsRef.current.onTurn?.();
          setShown({ i, label: propsRef.current.labels[i] ?? MOVE_NAMES[m.move] });
          p.next++;
          atRef.current = i + 1;
          setAt(i + 1);
          setMask(i + 1);
        }
        k = p.from + p.next;
        real = realAt(p, tp);
        if (tp >= p.end) {
          pb.current = null;
          setPlaying(false);
        }
      }
      // 向き: 目標をなめらかに追い、ドラッグした分を足す
      const target = targetQuat(k, real);
      const before = shownQ.current.clone();
      if (snapNext.current) {
        shownQ.current.copy(target);
        snapNext.current = false;
      } else approach(shownQ.current, target, dt, opts.current.view === "camera" ? 90 : 170);
      const d = drag.current;
      if (!d.on) approach(d.q, new Quaternion(), dt, 110);
      root.quaternion.copy(d.q).multiply(shownQ.current);
      return !!p || d.on || d.q.angleTo(new Quaternion()) > 1e-3 || before.angleTo(shownQ.current) > 1e-4;
    };
    setReady(true);
    return () => {
      ro.disconnect();
      s.dispose();
      scene.current = null;
    };
  }, []);

  // 手を押したとき・記録・速さが変わったとき: その手の前から再生
  useEffect(() => {
    if (ready) play(props.from);
  }, [ready, props.from, props.setupAlg, props.moves.length, speed]);

  // 見え方・スイッチを変えたら光り方を変える（向きは描画のループがなめらかに追う）
  useEffect(() => {
    if (!ready) return;
    setMask(atRef.current);
    scene.current?.invalidate();
  }, [view, follow, glow]);

  // ドラッグ: 指のとおりに回し、離すと戻る
  const onDown = (e: PointerEvent) => {
    const d = drag.current;
    d.on = true;
    d.x = e.clientX;
    d.y = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    scene.current?.invalidate();
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d.on) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), dx * 0.012).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), dy * 0.012));
    d.q.premultiply(turn);
    scene.current?.invalidate();
  };
  const onUp = () => {
    drag.current.on = false;
    scene.current?.invalidate();
  };

  const n = props.moves.length;
  const views: { id: ReplayView; label: string }[] = [
    { id: "camera", label: hasPoses ? "持った向き" : "持った向き（90° ごと）" },
    { id: "down", label: props.downLabel },
    { id: "fixed", label: "定点（白上）" },
  ];
  return (
    <div class="replay-cube">
      <div class="replay-stage">
        <div class="cube3d live-cube" ref={host} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
        {shown && playing && (
          <span class="replay-move" key={shown.i} aria-live="off">
            {shown.label}
          </span>
        )}
      </div>
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
      {!props.simple && (
        <>
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
        </>
      )}
    </div>
  );
}

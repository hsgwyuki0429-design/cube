// プレイ画面のライブの 3D キューブ。見えているキューブと同じ状態・同じ傾きを、自分の目線（少し上・右から見下ろす）で描く。
//
// - 状態: 一番合う仮説の手順を受け取り、足された手は 1 手ずつ回して見せる。前の手の解釈が変わった・手が溜まったら、回さずに
//   その状態へ切り替える（見えているキューブとずれたまま回し続けない）。作り変え（base・seen）はその場でその状態にする
// - 傾き（ジャイロ）: 認識の毎フレームの姿勢（キューブ固定 → カメラ）を、インカメラなら自分の側から見た向き（y2）に直し、
//   揺れをならして（src/ui/gyro.ts）なめらかに追う。姿勢が届かなくなったら、持ち方の向き（90° ごと）に戻す
import { useEffect, useRef } from "preact/hooks";
import { Quaternion } from "three";
import { controller } from "../app/controller";
import { ORIENTATIONS, ROTATION, applyMoves, mul, solvedState, type Mat3 } from "../cube/model";
import { CubeScene, approach, matToQuat } from "./cubeScene";
import { DEFAULT_GYRO, GyroFilter } from "./gyro";

export interface LiveCube3DProps {
  epoch: number;
  setupMoves: number[] | null;
  moves: number[];
  orient: number | null; // 持ち方の向き（カメラフレーム）。null なら白上・緑前
  follow: boolean; // 映っている傾きに追従する
  userEye: boolean; // 自分の側から見る（インカメラ: カメラとは反対の側から見ている）
  base?: { n: number; at: number; state: number[] } | null;
  seen?: { n: number; state: number[] } | null;
}

const LIVE_BACKLOG = 2; // 回さずに待たせておく手の数の上限
const NO_POSE_MS = 700; // これより姿勢が届かなければ持ち方の向きに戻す
const POSE_TAU = 85; // 傾きを追う時定数
const HOLD_TAU = 140; // 持ち方の向きへ戻る時定数
// 揺れを除く設定: 止まっているときは強くならし、先読みはしない（行き過ぎて戻るのが「よく分からない」動きに見えた）
const GYRO = { ...DEFAULT_GYRO, minCutoff: 0.5, beta: 2.2, predictMs: 0 };
const Y2 = mul(ROTATION.y, ROTATION.y);
const TILT_GAIN = 0.65; // 映った傾きをどれだけ 3D に移すか

export function LiveCube3D(props: LiveCube3DProps) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<CubeScene | null>(null);
  const keyRef = useRef("");
  const startRef = useRef<Uint8Array>(solvedState());
  const shown = useRef<number[]>([]);
  const propsRef = useRef(props);
  propsRef.current = props;

  // 向き
  const shownQ = useRef(new Quaternion());
  const targetQ = useRef(new Quaternion());
  const lastPoseAt = useRef(-1e9);
  const gyro = useRef(new GyroFilter(GYRO));

  const toView = (m: Mat3) => matToQuat(propsRef.current.userEye ? mul(Y2, m) : m);
  const holdQ = () => {
    const o = propsRef.current.orient;
    return propsRef.current.follow && o !== null ? toView(ORIENTATIONS[o]) : new Quaternion();
  };

  useEffect(() => {
    const s = new CubeScene();
    scene.current = s;
    host.current!.appendChild(s.canvas);
    const ro = new ResizeObserver(() => {
      const r = host.current?.getBoundingClientRect();
      if (r) s.resize(r.width, r.height);
    });
    ro.observe(host.current!);
    shownQ.current.copy(holdQ());
    s.onFrame = (now, dt, root) => {
      const p = propsRef.current;
      const live = p.follow && now - lastPoseAt.current < NO_POSE_MS;
      const target = live ? (gyro.current.target(now) ?? targetQ.current) : holdQ();
      const before = shownQ.current.clone();
      approach(shownQ.current, target, dt, live ? POSE_TAU : HOLD_TAU);
      root.quaternion.copy(shownQ.current);
      return before.angleTo(shownQ.current) > 1e-4 || shownQ.current.angleTo(target) > 1e-3;
    };
    apply();
    return () => {
      ro.disconnect();
      s.dispose();
      scene.current = null;
      keyRef.current = "";
      shown.current = [];
    };
  }, []);

  // 毎フレームの姿勢
  useEffect(() => {
    if (!props.follow) return;
    let cur = -1;
    let pending = -1;
    let count = 0;
    const off = controller.onFrameResult((m) => {
      if (!m.pose) return;
      const o = m.pose.orient;
      // 持ち替えは 2 フレーム続いてから（1 フレームの誤読で 90° 跳ねない）
      if (cur >= 0 && o !== cur) {
        count = o === pending ? count + 1 : 1;
        pending = o;
        if (count < 2) return;
      }
      cur = o;
      // 傾きは少し弱めて使う: 3D は少し上・右から見下ろす目線で描くので、映った傾きをそのまま足すと傾きすぎて読みにくく、揺れも目立つ
      const tilt = new Quaternion().slerp(matToQuat(m.pose.R), TILT_GAIN);
      const q = toView(ORIENTATIONS[o]).premultiply(props.userEye ? matToQuat(Y2).multiply(tilt).multiply(matToQuat(Y2)) : tilt);
      const now = performance.now();
      if (now - lastPoseAt.current > 600) gyro.current.reset();
      gyro.current.push(q, now);
      targetQ.current = q;
      lastPoseAt.current = now;
      scene.current?.invalidate();
    });
    return off;
  }, [props.follow, props.userEye]);

  useEffect(() => scene.current?.invalidate(), [props.orient, props.follow, props.userEye]);

  const apply = () => {
    const s = scene.current;
    if (!s || props.setupMoves === null) return;
    const v = props.seen;
    const b = props.base;
    let key = `${props.epoch}`;
    let start: ArrayLike<number> | null = null;
    let moves = props.moves;
    if (v) {
      key += `:v${v.n}`;
      start = v.state;
      moves = [];
    } else if (b) {
      key += `:b${b.n}`;
      start = b.state;
      moves = props.moves.slice(b.at);
    }
    if (keyRef.current !== key) {
      // 始まりが変わった（スキャン・やり直し・作り変え）: 回さずにその状態にする
      keyRef.current = key;
      startRef.current = start ? Uint8Array.from(start) : applyMoves(solvedState(), props.setupMoves);
      s.setState(applyMoves(startRef.current, moves));
      shown.current = [...moves];
      return;
    }
    const old = shown.current;
    let k = 0;
    while (k < old.length && k < moves.length && old[k] === moves[k]) k++;
    const done = old.length - s.waiting(); // 回し終えた（回している）手の数
    if (k < done || moves.length - done > LIVE_BACKLOG) {
      // 解釈が変わった・手が溜まった: 最後の 1 手の前までは回さずに合わせ、足された最後の手だけ回して見せる
      const appended = k >= old.length && moves.length > k;
      const upto = appended ? moves.length - 1 : moves.length;
      s.setState(applyMoves(startRef.current, moves.slice(0, upto)));
      s.setQueue(moves.slice(upto));
    } else {
      s.setQueue(moves.slice(done));
    }
    shown.current = [...moves];
  };

  useEffect(apply, [props.epoch, props.setupMoves, props.moves, props.base?.n, props.seen?.n]);

  return (
    <div class="cube3d live-cube" ref={host}>
      {props.setupMoves === null && <div class="loading">3D表示を準備中…</div>}
    </div>
  );
}

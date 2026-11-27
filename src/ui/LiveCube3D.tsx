// プレイ画面のライブの 3D キューブ。見えているキューブと同じ状態・同じ傾きを、自分の目線（少し上・右から見下ろす）で描く。
//
// - 状態: 一番合う仮説の手順を受け取り、足された手は 1 手ずつ回して見せる。回して見せるのは、その手の層が動いたのをフレームで
//   見た手だけ（moveSeen）で、見ていない手（傾けただけで面の割り当てが一瞬入れ替わったのを手で説明したものなど）は回さずに塗り替える。
//   前の手の解釈が変わった・手が溜まったら、回さずにその状態へ切り替える（見えているキューブとずれたまま回し続けない）。
//   作り変え（base・seen）はその場でその状態にする。見せ方の決まりは src/ui/liveShow.ts
// - 傾き（ジャイロ）: 認識の毎フレームの姿勢（キューブ固定 → カメラ）を、インカメラなら自分の側から見た向き（y2）に直し、
//   揺れをならして（src/ui/gyro.ts）なめらかに追う。姿勢が届かなくなったら、持ち方の向き（90° ごと）に戻す
import { useEffect, useRef } from "preact/hooks";
import { Quaternion } from "three";
import { controller } from "../app/controller";
import { ORIENTATIONS, mul, type Mat3 } from "../cube/model";
import { CubeScene, approach, matToQuat } from "./cubeScene";
import { DEFAULT_GYRO, GyroFilter } from "./gyro";
import { AGREE_WAIT_MS, LiveShow } from "./liveShow";

export interface LiveCube3DProps {
  epoch: number;
  setupMoves: number[] | null;
  moves: number[];
  moveSeen: boolean[]; // moves と同じ並び: その手の層が動いたのをフレームで見た（回して見せる。見ていない手は回さずに塗り替える）
  orient: number | null; // 持ち方の向き（カメラフレーム）。null なら白上・緑前
  follow: boolean; // 映っている傾きに追従する
  mirror: boolean; // 鏡像で描く（カメラのプレビューが鏡像のとき: インカメラ）
  base?: { n: number; at: number; state: number[] } | null;
  seen?: { n: number; state: number[] } | null;
  // ソルブ中のライブの状態の推定（TrackUpdate.agreed）: 候補の状態がどれも同じ手順で説明できる手の数。それより後の手は少し待って確かめる
  agreed?: number;
}

const NO_POSE_MS = 700; // これより姿勢が届かなければ持ち方の向きに戻す
const POSE_TAU = 85; // 傾きを追う時定数
const HOLD_TAU = 140; // 持ち方の向きへ戻る時定数
// 揺れを除く設定: 止まっているときは強くならし、先読みはしない（行き過ぎて戻るのが「よく分からない」動きに見えた）
const GYRO = { ...DEFAULT_GYRO, minCutoff: 0.5, beta: 2.2, predictMs: 0 };

export function LiveCube3D(props: LiveCube3DProps) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<CubeScene | null>(null);
  const show = useRef(new LiveShow());
  const propsRef = useRef(props);
  propsRef.current = props;

  // 向き
  const shownQ = useRef(new Quaternion());
  const targetQ = useRef(new Quaternion());
  const lastPoseAt = useRef(-1e9);
  const gyro = useRef(new GyroFilter(GYRO));

  const toView = (m: Mat3) => matToQuat(m);
  const holdQ = () => {
    const o = propsRef.current.orient;
    return propsRef.current.follow && o !== null ? toView(ORIENTATIONS[o]) : new Quaternion();
  };

  useEffect(() => {
    const s = new CubeScene();
    s.setEye(propsRef.current.follow);
    scene.current = s;
    host.current!.appendChild(s.canvas);
    const ro = new ResizeObserver(() => {
      const r = host.current?.getBoundingClientRect();
      if (r) s.resize(r.width, r.height);
    });
    ro.observe(host.current!);
    shownQ.current.copy(holdQ());
    // デモ（合成カメラ）では、回して見せた手・塗り替えた手を残す（scripts/e2e.mjs が本当の手と比べる）
    s.onTurn = (move, instant) => {
      if (controller.synthetic) (window.__cubevisionTurns ??= []).push({ move, t: performance.now(), instant });
    };
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
      show.current.reset();
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
      // カメラに映っているのと同じ向き: キューブ固定 → カメラ = 傾き R · 持ち方
      const q = toView(mul(m.pose.R, ORIENTATIONS[o]));
      const now = performance.now();
      if (now - lastPoseAt.current > 600) gyro.current.reset();
      gyro.current.push(q, now);
      targetQ.current = q;
      lastPoseAt.current = now;
      scene.current?.invalidate();
    });
    return off;
  }, [props.follow]);

  // 追従するときは真正面から（カメラと同じ見え方）、固定は少し上・右から
  useEffect(() => scene.current?.setEye(props.follow), [props.follow]);
  useEffect(() => scene.current?.invalidate(), [props.orient, props.follow]);

  const holdTimer = useRef(0);
  const apply = () => {
    const s = scene.current;
    const p = propsRef.current;
    if (!s) return;
    show.current.apply(s, { epoch: p.epoch, setupMoves: p.setupMoves, moves: p.moves, moveSeen: p.moveSeen, base: p.base, view: p.seen, ...(p.agreed !== undefined ? { agreed: p.agreed, now: performance.now() } : {}) });
    // 待っている手は、待ち終わったときにもう一度（新しい追跡の更新が来なくても出す）
    clearTimeout(holdTimer.current);
    if (show.current.held) holdTimer.current = window.setTimeout(apply, AGREE_WAIT_MS + 10);
  };

  useEffect(apply, [props.epoch, props.setupMoves, props.moves, props.moveSeen, props.base?.n, props.seen?.n, props.agreed]);
  useEffect(() => () => clearTimeout(holdTimer.current), []);

  return (
    <div class={`cube3d live-cube${props.mirror && props.follow ? " mirrored" : ""}`} ref={host}>
      {props.setupMoves === null && <div class="loading">3D表示を準備中…</div>}
    </div>
  );
}

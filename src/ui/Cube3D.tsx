// 3D キューブ（cubing.js の <twisty-player>）。追跡した手を順にアニメーションし、
// キューブの姿勢（カメラに映っている傾き）に合わせて全体を回す。
import { useEffect, useRef } from "preact/hooks";
import { Color, Matrix4, Quaternion, Vector3, type Object3D } from "three";
import type { TwistyPlayer } from "cubing/twisty";
import { controller } from "../app/controller";
import { MOVE_NAMES, ORIENTATIONS, ROTATION, mul } from "../cube/model";

export interface Cube3DProps {
  epoch: number; // 変わったら setup からやり直す
  setupMoves: number[] | null;
  moves: number[]; // キューブ固定フレームの手（開始から）
  orient: number | null; // 連続的な姿勢が来ないときに表示する向き（キューブ固定 → 表示）。null なら標準の向き
  view?: "camera" | "user" | "fixed"; // camera / user: 毎フレームの姿勢（傾き）に追従する
  mirror?: boolean; // 鏡像で表示（インカメラの鏡像プレビューに合わせる）
  colors?: string[] | null; // 面 U R F D L B の色（標準配色以外のとき）
  controls?: boolean; // 再生コントロール（履歴のリプレイ用）
  setupAlg?: string;
  alg?: string;
}

const EXTRAPOLATE_MS = 250;
const SPIN_MIN = (40 * Math.PI) / 180 / 1000; // rad/ms

// cubing.js の Cube3D は面ごとの素材を共有している（U L F R B D の順の色）
const DEFAULT_HEX: Record<number, number> = { 0: 0xffffff, 4: 0xff8800, 2: 0x00ff00, 1: 0xff0000, 5: 0x2266ff, 3: 0xffff00 };

function recolor(root: Object3D, colors: string[] | null) {
  const want = new Map<number, Color>();
  for (const [face, hex] of Object.entries(DEFAULT_HEX)) {
    const from = new Color(hex).convertLinearToSRGB().getHex();
    const css = colors?.[Number(face)];
    want.set(from, css ? new Color(css).convertLinearToSRGB() : new Color(hex).convertLinearToSRGB());
  }
  root.traverse((o) => {
    const mesh = o as unknown as { material?: { color?: Color; userData: Record<string, unknown> } };
    const mat = mesh.material;
    if (!mat?.color) return;
    const orig = (mat.userData.cvOrig as number | undefined) ?? mat.color.getHex();
    mat.userData.cvOrig = orig;
    const c = want.get(orig);
    if (c) mat.color.copy(c);
  });
}

function matToQuat(m: readonly number[]): Quaternion {
  return new Quaternion().setFromRotationMatrix(new Matrix4().set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1));
}

export function Cube3D(props: Cube3DProps) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<TwistyPlayer | null>(null);
  const shown = useRef<number[]>([]);
  const epochRef = useRef(-1);
  const puzzleObj = useRef<Object3D | null>(null);
  const targetQ = useRef(new Quaternion());
  const raf = useRef(0);
  const lastPoseAt = useRef(0);
  // 毎フレームの姿勢から求めた回転の速さ（ワールドの軸・rad/ms）。ぶれで数フレーム読めない間も、この速さで少し先まで回し続ける
  const spin = useRef<{ axis: Vector3; rate: number } | null>(null);
  const following = () => !props.controls && (props.view === "camera" || props.view === "user");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { TwistyPlayer } = await import("cubing/twisty");
      if (cancelled || !host.current) return;
      const p = new TwistyPlayer({
        puzzle: "3x3x3",
        visualization: "3D",
        controlPanel: props.controls ? "bottom-row" : "none",
        background: "none",
        hintFacelets: "none",
        backView: "none",
        experimentalDragInput: props.controls ? "auto" : "none",
        tempoScale: props.controls ? 1 : 3,
        // 追従するときは正面から（カメラと同じ視点）。固定のときは 3 面が見える標準の角度
        cameraLatitude: following() ? 0 : 28,
        cameraLongitude: following() ? 0 : 32,
      });
      host.current.appendChild(p);
      player.current = p;
      if (props.controls) {
        p.experimentalSetupAlg = props.setupAlg ?? "";
        p.alg = props.alg ?? "";
      }
      // cubing.js は別バージョンの three 型を同梱しているが、実体は同じ three
      puzzleObj.current = (await p.experimentalCurrentThreeJSPuzzleObject()) as unknown as Object3D;
      recolor(puzzleObj.current!, props.colors ?? null);
      apply();
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf.current);
      player.current?.remove();
      player.current = null;
      puzzleObj.current = null;
      epochRef.current = -1;
      shown.current = [];
    };
  }, []);

  const scheduleRender = async () => {
    const p = player.current;
    if (!p) return;
    for (const v of await p.experimentalCurrentVantages()) v.scheduleRender();
  };

  // 直前の姿勢から、回転の速さで先へ進めた向き（EXTRAPOLATE_MS まで進めてそこで止める・最大 60°。次の姿勢が届けばそちらへ寄せる）
  const predicted = (): { q: Quaternion; moving: boolean } => {
    const v = spin.current;
    if (!following() || !v) return { q: targetQ.current, moving: false };
    const elapsed = performance.now() - lastPoseAt.current;
    const angle = Math.min(v.rate * Math.min(elapsed, EXTRAPOLATE_MS), Math.PI / 3);
    return { q: new Quaternion().setFromAxisAngle(v.axis, angle).multiply(targetQ.current), moving: elapsed < EXTRAPOLATE_MS };
  };

  // 姿勢を滑らかに追従
  const animateOrientation = () => {
    cancelAnimationFrame(raf.current);
    const step = () => {
      const obj = puzzleObj.current;
      if (!obj) return;
      const { q: target, moving } = predicted();
      obj.quaternion.slerp(target, following() ? 0.3 : 0.18);
      scheduleRender();
      if (moving || obj.quaternion.angleTo(target) > 0.002) raf.current = requestAnimationFrame(step);
      else {
        obj.quaternion.copy(target);
        scheduleRender();
      }
    };
    raf.current = requestAnimationFrame(step);
  };

  const apply = () => {
    const p = player.current;
    if (!p || props.controls) return;
    if (props.setupMoves === null) return;
    if (epochRef.current !== props.epoch) {
      epochRef.current = props.epoch;
      p.experimentalSetupAlg = props.setupMoves.map((m) => MOVE_NAMES[m]).join(" ");
      p.alg = props.moves.map((m) => MOVE_NAMES[m]).join(" ");
      p.jumpToEnd();
      shown.current = [...props.moves];
    } else {
      const old = shown.current;
      let k = 0;
      while (k < old.length && k < props.moves.length && old[k] === props.moves[k]) k++;
      if (k === old.length) {
        for (const m of props.moves.slice(k)) p.experimentalAddMove(MOVE_NAMES[m]);
      } else {
        // 過去の手の解釈が変わった: 一気に置き換える
        p.alg = props.moves.map((m) => MOVE_NAMES[m]).join(" ");
        p.jumpToEnd();
      }
      shown.current = [...props.moves];
    }
  };

  useEffect(apply, [props.epoch, props.setupMoves, props.moves]);

  useEffect(() => {
    if (puzzleObj.current) {
      recolor(puzzleObj.current, props.colors ?? null);
      scheduleRender();
    }
  }, [props.colors?.join()]);

  useEffect(() => {
    // 連続的な姿勢が届いている間は、それに任せる
    if (following() && performance.now() - lastPoseAt.current < 600) return;
    spin.current = null;
    targetQ.current = props.orient === null ? new Quaternion() : matToQuat(ORIENTATIONS[props.orient]);
    animateOrientation();
  }, [props.orient]);

  // 毎フレームの姿勢に追従: キューブ固定 → カメラ = R（傾き）· ORIENTATIONS[orient]。自分視点はさらに y2
  useEffect(() => {
    const p = player.current;
    if (p) {
      p.cameraLatitude = following() ? 0 : 28;
      p.cameraLongitude = following() ? 0 : 32;
    }
    if (!following()) {
      targetQ.current = props.orient === null ? new Quaternion() : matToQuat(ORIENTATIONS[props.orient]);
      animateOrientation();
      return;
    }
    let cur = -1;
    let pending = -1;
    let count = 0;
    return controller.onFrameResult((m) => {
      if (!m.pose) return;
      const o = m.pose.orient;
      // 持ち替えの判定は 2 フレーム続いてから（1 フレームの誤読で 90° 跳ねないように）。待つ間は向きを動かさない:
      // 傾き R は新しい姿勢を基準にしているので、古い姿勢と組み合わせると 90° ずれた向きになり、1 フレームだけ跳ねていた
      if (cur >= 0 && o !== cur) {
        count = o === pending ? count + 1 : 1;
        pending = o;
        if (count < 2) return;
      }
      cur = o;
      const M = mul(m.pose.R, ORIENTATIONS[o]);
      const q = matToQuat(props.view === "user" ? mul(mul(ROTATION.y, ROTATION.y), M) : M);
      const now = performance.now();
      const dt = now - lastPoseAt.current;
      // 回転の速さ: 直前の姿勢からの差（q = dq · 前）。速いとき（40°/秒以上）だけ使う（止まっているときの揺れを先へ進めない）
      spin.current = null;
      if (dt > 0 && dt < 200) {
        const dq = q.clone().multiply(targetQ.current.clone().invert());
        if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
        const angle = 2 * Math.acos(Math.min(1, dq.w));
        const s = Math.sin(angle / 2);
        if (angle / dt > SPIN_MIN && angle < Math.PI / 2 && s > 1e-6) spin.current = { axis: new Vector3(dq.x / s, dq.y / s, dq.z / s), rate: angle / dt };
      }
      targetQ.current = q;
      lastPoseAt.current = now;
      animateOrientation();
    });
  }, [props.view, props.controls]);

  useEffect(() => {
    const p = player.current;
    if (!p || !props.controls) return;
    p.experimentalSetupAlg = props.setupAlg ?? "";
    p.alg = props.alg ?? "";
  }, [props.setupAlg, props.alg]);

  return (
    <div class={`cube3d${props.mirror ? " mirrored" : ""}`} ref={host}>
      {props.setupMoves === null && !props.controls && <div class="loading">3D表示を準備中…</div>}
    </div>
  );
}

// 3D キューブ（cubing.js の <twisty-player>）。追跡した手を順にアニメーションし、
// キューブの姿勢（カメラに映っている傾き）に合わせて全体を回す。
import { useEffect, useRef } from "preact/hooks";
import { Color, Matrix4, Quaternion, type Object3D } from "three";
import type { TwistyPlayer } from "cubing/twisty";
import { controller } from "../app/controller";
import { MOVE_NAMES, ORIENTATIONS, ROTATION, mul } from "../cube/model";
import { DEFAULT_GYRO, GyroFilter, follow } from "./gyro";

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

// 手のアニメーション: 1 手ずつ、前の手を回し終えてから次を回す（cubing.js は回している途中に次の手を足すと、前の手を一瞬で
// 終わらせるので、速く回すと回転が描かれない手があった）。ふだんは 1 手 約 170ms（tempoScale 3）、たまっていれば速めるが、
// 人が回るのを見て取れる 1 手 約 85ms（tempoScale 6）より速くしない
const BASE_TEMPO = 3;
const MAX_TEMPO = 6;
const CATCH_UP_MS = 500; // cubing.js の 1 手の長さ（tempoScale 1 のとき）

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

export function matToQuat(m: readonly number[]): Quaternion {
  return new Quaternion().setFromRotationMatrix(new Matrix4().set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1));
}

export function Cube3D(props: Cube3DProps) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<TwistyPlayer | null>(null);
  const shown = useRef<number[]>([]); // 表示する手（回し終えたものと、queue で待っているもの）
  const queue = useRef<number[]>([]); // まだ回していない手
  const pumping = useRef(0); // 次の手を回すタイマー
  const epochRef = useRef(-1);
  const puzzleObj = useRef<Object3D | null>(null);
  const targetQ = useRef(new Quaternion());
  const raf = useRef(0);
  const lastPoseAt = useRef(0);
  // 毎フレームの姿勢をならし、回る速さで次の姿勢までつなぐ（src/ui/gyro.ts）
  const gyro = useRef(new GyroFilter());
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
      clearTimeout(pumping.current);
      pumping.current = 0;
      queue.current = [];
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

  // 向きをなめらかに追う: カメラの傾きに追従するときは、ならした姿勢を回る速さで先へ進めた向き（src/ui/gyro.ts）を、
  // 時間でなめらかに追う（姿勢の届く間隔によらない）。追従しないときは持ち方の向きへ
  const animateOrientation = () => {
    cancelAnimationFrame(raf.current);
    let last = performance.now();
    const step = (now: number) => {
      const obj = puzzleObj.current;
      if (!obj) return;
      const dt = now - last;
      last = now;
      const target = (following() && gyro.current.target(now)) || targetQ.current;
      follow(obj.quaternion, target, dt, following() ? DEFAULT_GYRO.renderTauMs : 120);
      scheduleRender();
      if ((following() && gyro.current.moving(now)) || obj.quaternion.angleTo(target) > 0.002) raf.current = requestAnimationFrame(step);
      else {
        obj.quaternion.copy(target);
        scheduleRender();
      }
    };
    raf.current = requestAnimationFrame(step);
  };

  // 待っている手を 1 つ回し、回し終わるころに次を回す
  const pump = () => {
    pumping.current = 0;
    const p = player.current;
    const m = queue.current.shift();
    if (!p || m === undefined) return;
    const tempo = Math.min(MAX_TEMPO, BASE_TEMPO + 0.75 * queue.current.length);
    p.tempoScale = tempo;
    p.experimentalAddMove(MOVE_NAMES[m]);
    pumping.current = window.setTimeout(pump, CATCH_UP_MS / tempo + 15);
  };

  const apply = () => {
    const p = player.current;
    if (!p || props.controls) return;
    if (props.setupMoves === null) return;
    if (epochRef.current !== props.epoch) {
      epochRef.current = props.epoch;
      clearTimeout(pumping.current);
      pumping.current = 0;
      queue.current = [];
      p.experimentalSetupAlg = props.setupMoves.map((m) => MOVE_NAMES[m]).join(" ");
      p.alg = props.moves.map((m) => MOVE_NAMES[m]).join(" ");
      p.jumpToEnd();
      shown.current = [...props.moves];
      return;
    }
    const old = shown.current;
    let k = 0;
    while (k < old.length && k < props.moves.length && old[k] === props.moves[k]) k++;
    const done = old.length - queue.current.length; // 回し終えた（回している）手の数
    if (k >= done) {
      // 回した手はそのまま: 待っている手を新しい手順の続きに置き換える
      queue.current = props.moves.slice(done);
    } else {
      // 回した手の解釈が変わった（精密解析の結果に乗り換えたなど）: 変わらない所まで戻し、そこから先を 1 手ずつ回し直す
      clearTimeout(pumping.current);
      pumping.current = 0;
      p.alg = props.moves
        .slice(0, k)
        .map((m) => MOVE_NAMES[m])
        .join(" ");
      p.jumpToEnd();
      queue.current = props.moves.slice(k);
    }
    shown.current = [...props.moves];
    if (!pumping.current && queue.current.length) pump();
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
    gyro.current.reset();
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
      // 0.6 秒以上あいたら（見失っていた）ならさずに合わせ直す
      if (now - lastPoseAt.current > 600) gyro.current.reset();
      gyro.current.push(q, now);
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

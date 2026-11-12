// 3D キューブ（cubing.js の <twisty-player>）。追跡した手を順にアニメーションし、
// キューブの姿勢（カメラに映っている傾き）に合わせて全体を回す。
import { useEffect, useRef } from "preact/hooks";
import { Color, Matrix4, Quaternion, Vector3, type Object3D } from "three";
import type { TwistyPlayer } from "cubing/twisty";
import { controller } from "../app/controller";
import { MOVE_NAMES, ORIENTATIONS, ROTATION, movesToString, mul } from "../cube/model";
import { setupMovesFor } from "../cube/solver";
import { DEFAULT_GYRO, GyroFilter, follow } from "./gyro";

// 3D の TwistyPlayer の共通の設定（背景・ヒント・裏面の表示なし）
export const PLAYER_BASE = { puzzle: "3x3x3", visualization: "3D", background: "none", hintFacelets: "none", backView: "none" } as const;

// 3D の視点: 傾きに追従するときは正面から（カメラと同じ視点）。固定のときは 3 面が見える標準の角度
export const viewAngles = (front: boolean) => ({ cameraLatitude: front ? 0 : 28, cameraLongitude: front ? 0 : 32 });

export interface Cube3DProps {
  epoch: number; // 変わったら setup からやり直す
  setupMoves: number[] | null;
  moves: number[]; // キューブ固定フレームの手（開始から）
  orient: number | null; // 連続的な姿勢が来ないときに表示する向き（キューブ固定 → 表示）。null なら標準の向き
  view?: "camera" | "user" | "fixed"; // camera / user: 毎フレームの姿勢（傾き）に追従する
  mirror?: boolean; // 鏡像で表示（インカメラの鏡像プレビューに合わせる）
  colors?: string[] | null; // 面 U R F D L B の色（標準配色以外のとき）
  controls?: boolean; // 再生コントロール（履歴のリプレイ用）
  // ライブ: 見えているキューブと同じ状態を最優先にする。足された手は回して見せるが、溜まったら最後の 1 手の前まで回さずに進め、
  // 前の手の解釈が変わったら回し直さずにその状態へ切り替える
  live?: boolean;
  // ライブの作り変え（TrackUpdate.base）: 見えている色に合わせて作り変えた状態。3D はその場でこの状態にして、at 番目以降の手を回す
  base?: { n: number; at: number; state: number[] } | null;
  // ライブの表示だけの作り変え（TrackUpdate.view）: 追跡が見え方を説明できない間は、見えている色に合う状態をそのまま出す
  seen?: { n: number; state: number[] } | null;
  setupAlg?: string;
  alg?: string;
}

// 手のアニメーション: 1 手ずつ、前の手を回し終えてから次を回す（cubing.js は回している途中に次の手を足すと、前の手を一瞬で
// 終わらせるので、速く回すと回転が描かれない手があった）。ふだんは 1 手 約 170ms（tempoScale 3）、たまっていれば速めるが、
// 人が回るのを見て取れる 1 手 約 85ms（tempoScale 6）より速くしない
const BASE_TEMPO = 3;
const MAX_TEMPO = 6;
const CATCH_UP_MS = 500; // cubing.js の 1 手の長さ（tempoScale 1 のとき）
const LIVE_BACKLOG = 2; // ライブで回さずに待たせておく手の数の上限（これより溜まったら、見えているキューブに追いつかせる）

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

// 傾きに追従する表示で姿勢が届かないとき（1 面しか読めない・見失った）の向き: 真正面からだと 1 面しか見えないので、
// 少し上と右から見た向き（上・正面・右の 3 面が見える）にする
const NO_POSE_MS = 800;
const FALLBACK_TILT = new Quaternion()
  .setFromAxisAngle(new Vector3(0, 1, 0), (-30 * Math.PI) / 180)
  .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (25 * Math.PI) / 180));
const tilted = (q: Quaternion) => new Quaternion().multiplyQuaternions(FALLBACK_TILT, q);

export function matToQuat(m: readonly number[]): Quaternion {
  return new Quaternion().setFromRotationMatrix(new Matrix4().set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1));
}

export function Cube3D(props: Cube3DProps) {
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<TwistyPlayer | null>(null);
  const shown = useRef<number[]>([]); // 表示する手（回し終えたものと、queue で待っているもの）
  const queue = useRef<number[]>([]); // まだ回していない手
  const pumping = useRef(0); // 次の手を回すタイマー
  const epochRef = useRef("");
  // 作り変えた状態を作る手順（ソルバーの Worker で求める。求まるまでは前の表示のまま）
  const baseSetup = useRef<{ key: string; alg: string } | null>(null);
  const pendingBase = useRef("");
  const applyRef = useRef<() => void>(() => undefined);
  const puzzleObj = useRef<Object3D | null>(null);
  const targetQ = useRef(new Quaternion());
  const raf = useRef(0);
  const lastPoseAt = useRef(0);
  // 毎フレームの姿勢をならし、回る速さで次の姿勢までつなぐ（src/ui/gyro.ts）
  const gyro = useRef(new GyroFilter());
  const orientRef = useRef(props.orient);
  orientRef.current = props.orient;
  const following = () => !props.controls && (props.view === "camera" || props.view === "user");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { TwistyPlayer } = await import("cubing/twisty");
      if (cancelled || !host.current) return;
      const p = new TwistyPlayer({
        ...PLAYER_BASE,
        controlPanel: props.controls ? "bottom-row" : "none",
        experimentalDragInput: props.controls ? "auto" : "none",
        tempoScale: props.controls ? 1 : 3,
        ...viewAngles(following()),
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
      epochRef.current = "";
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
    // 表示の始まりの状態と、そこから回す手。ライブで作り変えたら、作り変えた状態からその後の手
    let setup = movesToString(props.setupMoves);
    let moves = props.moves;
    let key = `${props.epoch}`;
    // 表示だけの作り変え（view）があればその状態、なければ追跡の作り変え（base）からの手
    const v = props.live ? props.seen : null;
    const b = props.live ? props.base : null;
    const fixed = v ? { key: `${props.epoch}:v${v.n}`, state: v.state, at: props.moves.length } : b ? { key: `${props.epoch}:b${b.n}`, state: b.state, at: b.at } : null;
    if (fixed) {
      if (baseSetup.current?.key !== fixed.key) {
        if (pendingBase.current !== fixed.key) {
          pendingBase.current = fixed.key;
          setupMovesFor(Uint8Array.from(fixed.state))
            .then((ms) => {
              if (pendingBase.current !== fixed.key) return;
              baseSetup.current = { key: fixed.key, alg: movesToString(ms) };
              applyRef.current();
            })
            .catch((e) => console.warn("3D: 作り変えた状態を作れませんでした", e));
        }
        return;
      }
      setup = baseSetup.current.alg;
      moves = v ? [] : props.moves.slice(fixed.at);
      key = fixed.key;
    }
    if (epochRef.current !== key) {
      // 始まりが変わった（スキャン・やり直し・作り変え）: 回さずにその場でその状態にする
      epochRef.current = key;
      clearTimeout(pumping.current);
      pumping.current = 0;
      queue.current = [];
      p.experimentalSetupAlg = setup;
      p.alg = movesToString(moves);
      p.jumpToEnd();
      shown.current = [...moves];
      return;
    }
    const old = shown.current;
    let k = 0;
    while (k < old.length && k < moves.length && old[k] === moves[k]) k++;
    const done = old.length - queue.current.length; // 回し終えた（回している）手の数
    if (props.live && (k < done || moves.length - done > LIVE_BACKLOG)) {
      // 解釈が変わった・手が溜まった: 最後の 1 手の前までは回さずに合わせ、足された最後の手だけ回して見せる
      clearTimeout(pumping.current);
      pumping.current = 0;
      const appended = k >= old.length && moves.length > k;
      const upto = appended ? moves.length - 1 : moves.length;
      p.alg = moves
        .slice(0, upto)
        .map((m) => MOVE_NAMES[m])
        .join(" ");
      p.jumpToEnd();
      queue.current = moves.slice(upto);
    } else if (k >= done) {
      // 回した手はそのまま: 待っている手を新しい手順の続きに置き換える
      queue.current = moves.slice(done);
    } else {
      // 回した手の解釈が変わった: 変わらない所まで戻し、そこから先を 1 手ずつ回し直す
      clearTimeout(pumping.current);
      pumping.current = 0;
      p.alg = moves
        .slice(0, k)
        .map((m) => MOVE_NAMES[m])
        .join(" ");
      p.jumpToEnd();
      queue.current = moves.slice(k);
    }
    shown.current = [...moves];
    if (!pumping.current && queue.current.length) pump();
  };
  applyRef.current = apply;

  useEffect(apply, [props.epoch, props.setupMoves, props.moves, props.base?.n, props.seen?.n]);

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
    const q = props.orient === null ? new Quaternion() : matToQuat(ORIENTATIONS[props.orient]);
    targetQ.current = following() ? tilted(q) : q;
    animateOrientation();
  }, [props.orient]);

  // 毎フレームの姿勢に追従: キューブ固定 → カメラ = R（傾き）· ORIENTATIONS[orient]。自分視点はさらに y2
  useEffect(() => {
    const p = player.current;
    if (p) {
      Object.assign(p, viewAngles(following()));
    }
    if (!following()) {
      targetQ.current = props.orient === null ? new Quaternion() : matToQuat(ORIENTATIONS[props.orient]);
      animateOrientation();
      return;
    }
    let cur = -1;
    let pending = -1;
    let count = 0;
    // 姿勢が届かなくなったら、3 面が見える向きに（真正面のままだと 1 面しか見えない）
    let fallback = false;
    const timer = window.setInterval(() => {
      if (performance.now() - lastPoseAt.current < NO_POSE_MS || fallback) return;
      fallback = true;
      gyro.current.reset();
      const o = orientRef.current;
      targetQ.current = tilted(o === null ? new Quaternion() : matToQuat(ORIENTATIONS[o]));
      animateOrientation();
    }, 250);
    const off = controller.onFrameResult((m) => {
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
      fallback = false;
      animateOrientation();
    });
    return () => {
      clearInterval(timer);
      off();
    };
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

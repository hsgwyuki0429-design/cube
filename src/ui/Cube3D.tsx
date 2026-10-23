// 3D キューブ（cubing.js の <twisty-player>）。追跡した手を順にアニメーションし、
// 必要ならキューブの持ち方（姿勢）に合わせて全体を回す。
import { useEffect, useRef } from "preact/hooks";
import { Color, Matrix4, Quaternion, type Object3D } from "three";
import type { TwistyPlayer } from "cubing/twisty";
import { MOVE_NAMES, ORIENTATIONS } from "../cube/model";

export interface Cube3DProps {
  epoch: number; // 変わったら setup からやり直す
  setupMoves: number[] | null;
  moves: number[]; // キューブ固定フレームの手（開始から）
  orient: number | null; // 表示する向き（キューブ固定 → 表示）。null なら標準の向き
  colors?: string[] | null; // 面 U R F D L B の色（標準配色以外のとき）
  controls?: boolean; // 再生コントロール（履歴のリプレイ用）
  setupAlg?: string;
  alg?: string;
}

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
        cameraLatitude: 28,
        cameraLongitude: 32,
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

  // 姿勢を滑らかに追従
  const animateOrientation = () => {
    cancelAnimationFrame(raf.current);
    const step = () => {
      const obj = puzzleObj.current;
      if (!obj) return;
      obj.quaternion.slerp(targetQ.current, 0.18);
      scheduleRender();
      if (obj.quaternion.angleTo(targetQ.current) > 0.002) raf.current = requestAnimationFrame(step);
      else {
        obj.quaternion.copy(targetQ.current);
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
    targetQ.current = props.orient === null ? new Quaternion() : matToQuat(ORIENTATIONS[props.orient]);
    animateOrientation();
  }, [props.orient]);

  useEffect(() => {
    const p = player.current;
    if (!p || !props.controls) return;
    p.experimentalSetupAlg = props.setupAlg ?? "";
    p.alg = props.alg ?? "";
  }, [props.setupAlg, props.alg]);

  return (
    <div class="cube3d" ref={host}>
      {props.setupMoves === null && !props.controls && <div class="loading">3D表示を準備中…</div>}
    </div>
  );
}

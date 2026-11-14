// ライブの 3D キューブの描画（three.js を直接使う。cubing.js の TwistyPlayer は使わない）。DOM は canvas だけ。
//
// 見た目は本物のスピードキューブに寄せる: 黒い本体の角の丸いキューブ 26 個に、角の丸いステッカー。少し上・右から見下ろす
// 目線（上・正面・右の 3 面が見える）で、遠近をつけて描く。
// 状態は facelet の色（src/cube/model.ts と同じ 54 枚）で持ち、ステッカーの色を塗り替えて表す。手を回すときは、その層の
// キューブを回転の軸のまわりに回して見せ、回し終えたら回転を戻して回した後の色に塗り替える（見た目は同じ）。
import {
  AmbientLight,
  CanvasTexture,
  Color,
  DirectionalLight,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Quaternion,
  Scene,
  Shape,
  ShapeGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { NORMAL, applyMove, faceletGeometry, moveAmount, moveFace, solvedState, type CubeState } from "../cube/model";

// 面 U R F D L B の色（明るい標準配色。スピードキューブのステッカーに近い色）
export const FACE_COLORS = ["#f4f5f0", "#e3263a", "#13b255", "#ffd42a", "#ff7a12", "#1f5fe0"];

// 見る目線: 少し上（緯度）・少し右（経度）から
const EYE_LAT = (26 * Math.PI) / 180;
const EYE_LON = (32 * Math.PI) / 180;
const EYE_DIST = 12.5;

// 回す速さ: 1/4 回転・半回転の長さ（ms）。待っている手があれば速める（下限あり）
export const TURN_MS = 190;
export const HALF_MS = 270;
export const MIN_TURN_MS = 85;

// 回し方の動き: 最初に素早く動き、最後にすっと止まる（少しだけ行き過ぎて戻る: 本物のキューブのカチッと止まる感じ）
export function turnEase(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const c = 1.15;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
}

interface Turn {
  move: number;
  start: number;
  dur: number;
  axis: Vector3;
  angle: number;
}

export class CubeScene {
  readonly canvas: HTMLCanvasElement;
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(26, 1, 0.1, 100);
  private root = new Group(); // キューブ全体（傾き）
  private pivot = new Group(); // 回している層
  private cubies: { group: Group; pos: [number, number, number] }[] = [];
  private stickers: Mesh[] = []; // facelet 番号の順
  private mats: MeshStandardMaterial[];
  private state: CubeState = solvedState();
  private turn: Turn | null = null;
  private queue: { move: number; dur: number }[] = [];
  private dimMats: MeshStandardMaterial[];
  private grayMat: MeshStandardMaterial;
  private mask: PieceMask | null = null;
  // 手を回し始めたとき
  onTurn: ((move: number) => void) | null = null;
  private dirty = true;
  private raf = 0;
  private disposed = false;
  // 毎フレーム呼ぶ（向きの更新など）。true を返すと描き続ける
  onFrame: ((now: number, dt: number, root: Group) => boolean) | null = null;

  constructor() {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.canvas = this.renderer.domElement;

    const pmrem = new PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.add(new AmbientLight(0xffffff, 0.35));
    const key = new DirectionalLight(0xffffff, 1.5);
    key.position.set(3, 6, 5);
    this.scene.add(key);
    const fill = new DirectionalLight(0xffffff, 0.35);
    fill.position.set(-5, -2, 3);
    this.scene.add(fill);

    this.camera.position.set(EYE_DIST * Math.cos(EYE_LAT) * Math.sin(EYE_LON), EYE_DIST * Math.sin(EYE_LAT), EYE_DIST * Math.cos(EYE_LAT) * Math.cos(EYE_LON));
    this.camera.lookAt(0, 0, 0);

    this.mats = FACE_COLORS.map((c) => new MeshStandardMaterial({ color: new Color(c), roughness: 0.28, metalness: 0, envMapIntensity: 0.55 }));
    this.dimMats = FACE_COLORS.map((c) => new MeshStandardMaterial({ color: new Color(c).multiplyScalar(0.3), roughness: 0.5, metalness: 0, envMapIntensity: 0.2 }));
    this.grayMat = new MeshStandardMaterial({ color: 0x5a5a60, roughness: 0.6, metalness: 0, envMapIntensity: 0.2 });
    const body = new MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.42, metalness: 0, envMapIntensity: 0.6 });
    const boxGeo = new RoundedBoxGeometry(0.985, 0.985, 0.985, 4, 0.11);
    const stickerGeo = roundedSquare(0.86, 0.14);
    this.scene.add(this.root);
    this.root.add(this.pivot);

    // 床の影（キューブの下にぼんやり。縁はぼかす）
    const shadow = new Mesh(new PlaneGeometry(5, 5), new MeshBasicMaterial({ map: softSpot(), transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -2.6;
    this.scene.add(shadow);

    const byPos = new Map<string, Group>();
    for (let x = -1; x <= 1; x++)
      for (let y = -1; y <= 1; y++)
        for (let z = -1; z <= 1; z++) {
          if (!x && !y && !z) continue;
          const g = new Group();
          g.position.set(x, y, z);
          g.add(new Mesh(boxGeo, body));
          this.root.add(g);
          this.cubies.push({ group: g, pos: [x, y, z] });
          byPos.set(`${x},${y},${z}`, g);
        }
    for (let i = 0; i < 54; i++) {
      const { pos, normal } = faceletGeometry(i);
      const m = new Mesh(stickerGeo, this.mats[Math.floor(i / 9)]);
      const n = new Vector3(...normal);
      m.position.copy(n.clone().multiplyScalar(0.4945));
      m.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), n);
      byPos.get(pos.join(","))!.add(m);
      this.stickers.push(m);
    }
    this.raf = requestAnimationFrame(this.loop);
  }

  resize(w: number, h: number): void {
    if (w < 2 || h < 2) return;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  // その場でこの状態にする（回さない）
  setState(state: ArrayLike<number>): void {
    this.cancelTurns();
    this.state = Uint8Array.from(state);
    this.paint();
  }

  getState(): CubeState {
    return this.state;
  }

  // 手を回す（前の手を回し終えてから）。dur（ms）を渡せばその長さで、なければ決まった速さ（溜まっていれば速める）
  enqueue(move: number, dur = 0): void {
    this.queue.push({ move, dur });
  }

  // ピースごとの見せ方（null = 全部ふつう）。ピースはステッカーの色の組で見分ける（センターは 1 色）
  setMask(mask: PieceMask | null): void {
    this.mask = mask;
    this.paint();
  }

  // 回している手があるか
  turning(): boolean {
    return !!this.turn;
  }

  // 待っている手の数（回している手は含まない）
  waiting(): number {
    return this.queue.length;
  }

  // 待っている手を置き換える（回している手はそのまま）
  setQueue(moves: number[]): void {
    this.queue = moves.map((move) => ({ move, dur: 0 }));
  }

  // 回している途中の手・待っている手をやめる（回している手は回し終えたことにしない）
  cancelTurns(): void {
    this.queue = [];
    if (this.turn) this.endTurn(false);
  }

  invalidate(): void {
    this.dirty = true;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }

  private paint(): void {
    const mask = this.mask;
    if (!mask) for (let i = 0; i < 54; i++) this.stickers[i].material = this.mats[this.state[i]];
    else
      for (const ids of PIECES) {
        const colors = ids.map((i) => this.state[i]);
        const look = mask(colors);
        for (const i of ids) this.stickers[i].material = look === "gray" ? this.grayMat : look === "dim" ? this.dimMats[this.state[i]] : this.mats[this.state[i]];
      }
    this.dirty = true;
  }

  private startTurn(now: number): void {
    const next = this.queue.shift();
    if (!next) return;
    const f = moveFace(next.move);
    const amount = moveAmount(next.move);
    const n = NORMAL[f];
    // 時計回り（外から見て）= 外向きの法線のまわりに -90°
    const angle = amount === 1 ? -Math.PI / 2 : amount === 2 ? -Math.PI : Math.PI / 2;
    const base = amount === 2 ? HALF_MS : TURN_MS;
    const speed = 1 + 0.45 * this.queue.length; // 溜まっていれば速める
    const dur = next.dur > 0 ? next.dur : Math.max(amount === 2 ? MIN_TURN_MS * 1.3 : MIN_TURN_MS, base / speed);
    for (const c of this.cubies) if (c.pos[0] * n[0] + c.pos[1] * n[1] + c.pos[2] * n[2] === 1) this.pivot.add(c.group);
    this.turn = { move: next.move, start: now, dur, axis: new Vector3(...n), angle };
    this.onTurn?.(next.move);
  }

  private endTurn(done: boolean): void {
    const t = this.turn!;
    this.turn = null;
    for (const c of this.cubies) if (c.group.parent === this.pivot) this.root.add(c.group);
    this.pivot.quaternion.identity();
    if (done) this.state = applyMove(this.state, t.move);
    this.paint();
  }

  private last = 0;
  private loop = (now: number) => {
    if (this.disposed) return;
    const dt = this.last ? Math.min(100, now - this.last) : 16;
    this.last = now;
    if (!this.turn && this.queue.length) this.startTurn(now);
    if (this.turn) {
      const t = (now - this.turn.start) / this.turn.dur;
      if (t >= 1) {
        this.endTurn(true);
        if (this.queue.length) this.startTurn(now);
      }
      if (this.turn) {
        const k = turnEase((now - this.turn.start) / this.turn.dur);
        this.pivot.quaternion.setFromAxisAngle(this.turn.axis, this.turn.angle * k);
      }
      this.dirty = true;
    }
    if (this.onFrame?.(now, dt, this.root)) this.dirty = true;
    if (this.dirty) {
      this.dirty = false;
      this.renderer.render(this.scene, this.camera);
    }
    this.raf = requestAnimationFrame(this.loop);
  };
}

export type PieceLook = "on" | "dim" | "gray";
export type PieceMask = (colors: number[]) => PieceLook;

// キュービーごとの facelet 番号（センター・エッジ・コーナー）
const PIECES: number[][] = (() => {
  const by = new Map<string, number[]>();
  for (let i = 0; i < 54; i++) {
    const k = faceletGeometry(i).pos.join(",");
    by.set(k, [...(by.get(k) ?? []), i]);
  }
  return [...by.values()];
})();

// 行優先 3×3 の回転行列 → 四元数
export function matToQuat(m: readonly number[]): Quaternion {
  return new Quaternion().setFromRotationMatrix(new Matrix4().set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1));
}

// q に一番近い 24 通りの持ち方（90° ごと）から、q へ gain の割合だけ傾けた向き（映った傾きを弱めて見せる）
const ORIENT_QUATS: Quaternion[] = [];
export function damped(q: Quaternion, gain: number, orientations: readonly (readonly number[])[]): Quaternion {
  if (!ORIENT_QUATS.length) for (const m of orientations) ORIENT_QUATS.push(matToQuat(m));
  let best = ORIENT_QUATS[0];
  let bd = -1;
  for (const o of ORIENT_QUATS) {
    const d = Math.abs(o.dot(q));
    if (d > bd) {
      bd = d;
      best = o;
    }
  }
  return best.clone().slerp(q, gain);
}

// 真ん中が濃く、縁へ消えていく丸い影
function softSpot(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, "rgba(0,0,0,0.32)");
  r.addColorStop(0.5, "rgba(0,0,0,0.14)");
  r.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

function roundedSquare(size: number, r: number): ShapeGeometry {
  const h = size / 2;
  const s = new Shape();
  s.moveTo(-h + r, -h);
  s.lineTo(h - r, -h);
  s.quadraticCurveTo(h, -h, h, -h + r);
  s.lineTo(h, h - r);
  s.quadraticCurveTo(h, h, h - r, h);
  s.lineTo(-h + r, h);
  s.quadraticCurveTo(-h, h, -h, h - r);
  s.lineTo(-h, -h + r);
  s.quadraticCurveTo(-h, -h, -h + r, -h);
  return new ShapeGeometry(s, 6);
}

// 向きを時間でなめらかに追う（時定数 tauMs）
export function approach(cur: Quaternion, target: Quaternion, dtMs: number, tauMs: number): void {
  cur.slerp(target, 1 - Math.exp(-Math.max(0, dtMs) / tauMs));
}

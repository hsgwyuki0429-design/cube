// 合成カメラ: three.js で本物らしいキューブを描き、canvas.captureStream() でカメラの代わりにする。
// デモモード（キューブなしで試す）と、ヘッドレス Chromium での端から端までのテストに使う。
// 正解の手順（truth）を持っているので、追跡結果と比較できる。
import * as THREE from "three";
import { markerBits } from "../aruco/dict4x4";
import { FACE_TURN, NORMAL, ORIENTATIONS, ROWDIR, type CubeState, applyMove, cubeFaceAt, faceletAt, moveAmount, moveFace, solvedState, F, U } from "../cube/model";

const COLORS = [0xf2f2f2, 0xc8102e, 0x009b48, 0xffd500, 0xff5800, 0x0046ad]; // U R F D L B

interface Cubie {
  obj: THREE.Object3D;
  pos: [number, number, number]; // キューブ固定フレームでの論理位置
}

interface Anim {
  kind: "move" | "orient";
  move?: number;
  from?: THREE.Quaternion;
  to?: THREE.Quaternion;
  duration: number;
  start: number;
  pivot?: THREE.Object3D;
  cubies?: Cubie[];
  resolve: () => void;
}

export interface SyntheticOptions {
  width?: number;
  height?: number;
  fps?: number;
  hands?: boolean; // 回転中に指（肌色の物体）が一部を隠す
  wobble?: boolean;
  aruco?: boolean; // 各ステッカーに色付き ArUco マーカー（ID = 揃った状態での facelet 番号）を描く
}

// ArUco ステッカー: 外側に辺の 8% の色の余白、マーカーの白いセルをステッカーの色に置き換える（印刷した PDF と同じ）。
// マーカーの上辺はその面の「上」（行 0 の側 = -ROWDIR）
function arucoSticker(geom: THREE.PlaneGeometry, id: number, face: number): THREE.Mesh {
  const N = 100;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = N;
  const ctx = canvas.getContext("2d")!;
  const color = `#${COLORS[face].toString(16).padStart(6, "0")}`;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, N, N);
  const bits = markerBits(id);
  const m = N * 0.08;
  const cell = (N - 2 * m) / 6;
  ctx.fillStyle = "#151515";
  for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) if (!bits[r * 6 + c]) ctx.fillRect(m + c * cell, m + r * cell, cell + 0.5, cell + 0.5);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.45 }));
  const n = new THREE.Vector3(...NORMAL[face]);
  const up = new THREE.Vector3(...ROWDIR[face]).multiplyScalar(-1);
  const right = new THREE.Vector3().crossVectors(up, n);
  mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, n));
  mesh.position.copy(n.clone().multiplyScalar(0.491));
  return mesh;
}

function matToQuat(m: readonly number[]): THREE.Quaternion {
  const m4 = new THREE.Matrix4().set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1);
  return new THREE.Quaternion().setFromRotationMatrix(m4);
}

export class SyntheticCube {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private group = new THREE.Group(); // キューブ全体（姿勢）
  private wobbleGroup = new THREE.Group();
  private cubies: Cubie[] = [];
  private queue: (() => Anim)[] = [];
  private current: Anim | null = null;
  private finger: THREE.Mesh;
  private raf = 0;
  private opts: Required<SyntheticOptions>;
  private camTarget = new THREE.Vector3(0, 0, 0);
  private camPos = new THREE.Vector3(0, 4, 9);
  private camFrom: THREE.Vector3 | null = null;
  private camAnim: { start: number; duration: number; to: THREE.Vector3 } | null = null;
  state: CubeState = solvedState();
  orient = 0;
  truth: { move: number; t: number; start: number }[] = []; // start / t: 回し始め・回し終わり（performance.now()）
  solveFrom = -1; // タイマーのテストで、解き始めた手の位置（truth の添字）
  busy = false;

  constructor(options: SyntheticOptions = {}) {
    this.opts = { width: 960, height: 540, fps: 30, hands: true, wobble: true, aruco: false, ...options };
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.opts.width;
    this.canvas.height = this.opts.height;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setSize(this.opts.width, this.opts.height, false);
    this.scene.background = new THREE.Color(0x5b5048);
    this.camera = new THREE.PerspectiveCamera(42, this.opts.width / this.opts.height, 0.1, 100);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(3, 8, 6);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-6, 2, 4);
    this.scene.add(fill);
    this.scene.add(this.wobbleGroup);
    this.wobbleGroup.add(this.group);
    this.build();
    this.finger = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 1.6, 6, 12), new THREE.MeshStandardMaterial({ color: 0xd9a383, roughness: 0.8 }));
    this.finger.visible = false;
    this.scene.add(this.finger);
    this.updateCamera();
  }

  private build(): void {
    const body = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.6 });
    const box = new THREE.BoxGeometry(0.98, 0.98, 0.98);
    const sticker = new THREE.PlaneGeometry(0.84, 0.84);
    const mats = COLORS.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.45 }));
    for (let x = -1; x <= 1; x++)
      for (let y = -1; y <= 1; y++)
        for (let z = -1; z <= 1; z++) {
          if (!x && !y && !z) continue;
          const obj = new THREE.Group();
          obj.add(new THREE.Mesh(box, body));
          NORMAL.forEach((n, f) => {
            if (n[0] * x + n[1] * y + n[2] * z !== 1) return;
            if (this.opts.aruco) {
              obj.add(arucoSticker(sticker, faceletAt([x, y, z], n), f));
              return;
            }
            const s = new THREE.Mesh(sticker, mats[f]);
            s.position.set(n[0] * 0.491, n[1] * 0.491, n[2] * 0.491);
            s.lookAt(n[0] * 2, n[1] * 2, n[2] * 2);
            obj.add(s);
          });
          obj.position.set(x, y, z);
          this.group.add(obj);
          this.cubies.push({ obj, pos: [x, y, z] });
        }
  }

  stream(): MediaStream {
    if (!this.raf) this.loop();
    return this.canvas.captureStream(this.opts.fps);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  // カメラの位置（"front" = 正面から1面、"top" = 斜め上から2面、"corner" = 角から3面）
  setView(view: "front" | "top" | "corner", animateMs = 600): void {
    const to = view === "front" ? new THREE.Vector3(0.3, 0.8, 9.5) : view === "top" ? new THREE.Vector3(0.6, 5, 8.5) : new THREE.Vector3(5, 5, 7.5);
    if (animateMs <= 0) {
      this.camPos.copy(to);
      this.camAnim = null;
      this.updateCamera();
      return;
    }
    this.camFrom = this.camPos.clone();
    this.camAnim = { start: performance.now(), duration: animateMs, to };
  }

  private updateCamera(): void {
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);
  }

  // 状態を即座に設定（スクランブル済みから始めるなど）
  setStateInstant(moves: number[]): void {
    for (const m of moves) this.applyMoveInstant(m);
  }

  private layerCubies(face: number): Cubie[] {
    const n = NORMAL[face];
    return this.cubies.filter((c) => c.pos[0] * n[0] + c.pos[1] * n[1] + c.pos[2] * n[2] === 1);
  }

  private bake(cubies: Cubie[], move: number): void {
    const f = moveFace(move);
    const turn = FACE_TURN[f];
    for (const c of cubies) {
      for (let k = 0; k < moveAmount(move); k++) {
        const [x, y, z] = c.pos;
        c.pos = [turn[0] * x + turn[1] * y + turn[2] * z, turn[3] * x + turn[4] * y + turn[5] * z, turn[6] * x + turn[7] * y + turn[8] * z];
      }
      c.obj.position.set(...c.pos);
      // 回転を 90° 単位に丸める（回転行列の成分を整数に）
      const m = new THREE.Matrix4().makeRotationFromQuaternion(c.obj.quaternion);
      m.elements.forEach((v, i) => (m.elements[i] = Math.round(v)));
      c.obj.quaternion.setFromRotationMatrix(m);
    }
    this.state = applyMove(this.state, move);
  }

  private applyMoveInstant(move: number): void {
    const cubies = this.layerCubies(moveFace(move));
    const n = NORMAL[moveFace(move)];
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...n), (-Math.PI / 2) * moveAmount(move));
    for (const c of cubies) c.obj.quaternion.premultiply(q);
    this.bake(cubies, move);
  }

  // 1手をアニメーションで回す（durationMs）。truth に記録する
  move(move: number, durationMs = 150): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(() => {
        const pivot = new THREE.Object3D();
        this.group.add(pivot);
        const cubies = this.layerCubies(moveFace(move));
        for (const c of cubies) pivot.attach(c.obj);
        return { kind: "move", move, duration: durationMs, start: performance.now(), pivot, cubies, resolve };
      });
    });
  }

  // キューブ全体の姿勢（キューブ固定 → カメラフレーム）をアニメーションで変える
  setOrientation(o: number, durationMs = 600): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(() => ({
        kind: "orient",
        from: this.group.quaternion.clone(),
        to: matToQuat(ORIENTATIONS[o]),
        duration: durationMs,
        start: performance.now(),
        resolve: () => {
          this.orient = o;
          resolve();
        },
      }));
    });
  }

  // 面 face をカメラ正面に、面 top を上にする
  showFace(face: number, top: number, durationMs = 700): Promise<void> {
    const o = Array.from({ length: 24 }, (_, i) => i).find((i) => cubeFaceAt(i, F) === face && cubeFaceAt(i, U) === top);
    return this.setOrientation(o ?? 0, durationMs);
  }

  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(() => ({ kind: "orient", from: this.group.quaternion.clone(), to: this.group.quaternion.clone(), duration: ms, start: performance.now(), resolve }));
    });
  }

  private loop(): void {
    const tick = (now: number) => {
      this.raf = requestAnimationFrame(tick);
      this.step(now);
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private step(now: number): void {
    if (this.camAnim && this.camFrom) {
      const k = Math.min(1, (now - this.camAnim.start) / this.camAnim.duration);
      this.camPos.lerpVectors(this.camFrom, this.camAnim.to, k * k * (3 - 2 * k));
      if (k >= 1) this.camAnim = null;
      this.updateCamera();
    }
    if (this.opts.wobble) {
      this.wobbleGroup.rotation.set(Math.sin(now / 1300) * 0.05, Math.sin(now / 1700) * 0.07, Math.sin(now / 2100) * 0.04);
      this.wobbleGroup.position.set(Math.sin(now / 1900) * 0.15, Math.sin(now / 1500) * 0.1, 0);
    }
    if (!this.current && this.queue.length) this.current = this.queue.shift()!();
    this.busy = !!this.current || this.queue.length > 0;
    const a = this.current;
    if (!a) {
      this.finger.visible = false;
      return;
    }
    const k = Math.min(1, (now - a.start) / Math.max(1, a.duration));
    const ease = k * k * (3 - 2 * k);
    if (a.kind === "orient") {
      this.group.quaternion.slerpQuaternions(a.from!, a.to!, ease);
    } else {
      const f = moveFace(a.move!);
      const axis = new THREE.Vector3(...NORMAL[f]);
      a.pivot!.quaternion.setFromAxisAngle(axis, (-Math.PI / 2) * moveAmount(a.move!) * ease);
      if (this.opts.hands) this.placeFinger(f, ease);
    }
    if (k >= 1) {
      if (a.kind === "move") {
        for (const c of a.cubies!) this.group.attach(c.obj);
        this.group.remove(a.pivot!);
        this.bake(a.cubies!, a.move!);
        this.truth.push({ move: a.move!, t: now, start: a.start! });
      }
      this.current = null;
      a.resolve();
    }
  }

  // 回している面の近く（カメラ側）に指を出す
  private placeFinger(face: number, k: number): void {
    const n = new THREE.Vector3(...NORMAL[face]).applyQuaternion(this.group.quaternion);
    const toCam = this.camPos.clone().normalize();
    const p = n.clone().multiplyScalar(1.9).add(toCam.clone().multiplyScalar(1.2));
    p.y -= 0.4;
    this.finger.position.copy(p);
    this.finger.lookAt(p.clone().add(new THREE.Vector3(0.3, 1, 0.2)));
    this.finger.visible = k > 0.05 && k < 0.95;
  }
}

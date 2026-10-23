// キューブ状態モデル（3D座標モデル）。カメラも DOM も知らない純粋モジュール。
//
// 状態は「キューブ固定フレーム」での 54 枚のステッカー色。センターは動かない（フェイスターンのみ）ので、
// 色 = そのセンターが属する面の番号（0..5）。どんな配色のキューブでも同じ扱いになる。
//
// facelet の番号: face * 9 + row * 3 + col（face は U R F D L B の順）。
// 各面の row/col の向きは CLAUDE.md の表どおり（展開図として外側から見た向き）。

export type Vec3 = [number, number, number];

export const FACES = ["U", "R", "F", "D", "L", "B"] as const;
export type FaceName = (typeof FACES)[number];
export const U = 0, R = 1, F = 2, D = 3, L = 4, B = 5;

export const NORMAL: Vec3[] = [
  [0, 1, 0],
  [1, 0, 0],
  [0, 0, 1],
  [0, -1, 0],
  [-1, 0, 0],
  [0, 0, -1],
];
export const ROWDIR: Vec3[] = [
  [0, 0, 1],
  [0, -1, 0],
  [0, -1, 0],
  [0, 0, -1],
  [0, -1, 0],
  [0, -1, 0],
];
export const COLDIR: Vec3[] = [
  [1, 0, 0],
  [0, 0, -1],
  [1, 0, 0],
  [1, 0, 0],
  [0, 0, 1],
  [-1, 0, 0],
];
export const OPPOSITE = [D, L, B, U, R, F];

const key = (p: Vec3, n: Vec3) => `${p[0]},${p[1]},${p[2]}|${n[0]},${n[1]},${n[2]}`;

export function faceletGeometry(index: number): { pos: Vec3; normal: Vec3 } {
  const f = Math.floor(index / 9);
  const row = Math.floor((index % 9) / 3);
  const col = index % 3;
  const n = NORMAL[f];
  const pos = [0, 1, 2].map((k) => n[k] + ROWDIR[f][k] * (row - 1) + COLDIR[f][k] * (col - 1)) as Vec3;
  return { pos, normal: n };
}

const GEOMETRY = Array.from({ length: 54 }, (_, i) => faceletGeometry(i));
const INDEX_OF = new Map(GEOMETRY.map((g, i) => [key(g.pos, g.normal), i]));

export function faceletAt(pos: Vec3, normal: Vec3): number {
  const i = INDEX_OF.get(key(pos, normal));
  if (i === undefined) throw new Error(`no facelet at ${key(pos, normal)}`);
  return i;
}

// ---- 3x3 回転行列（整数） ----
// 行優先 9 要素。v' = M v
export type Mat3 = readonly number[];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mul(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) out[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return out;
}

export function apply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

// 面 f を外側から見て時計回り 90° の変換（CLAUDE.md の表）。
export const FACE_TURN: Mat3[] = [
  [0, 0, -1, 0, 1, 0, 1, 0, 0], // U: (x,y,z) -> (-z, y, x)
  [1, 0, 0, 0, 0, 1, 0, -1, 0], // R: (x,y,z) -> (x, z, -y)
  [0, 1, 0, -1, 0, 0, 0, 0, 1], // F: (x,y,z) -> (y, -x, z)
  [0, 0, 1, 0, 1, 0, -1, 0, 0], // D: (x,y,z) -> (z, y, -x)
  [1, 0, 0, 0, 0, -1, 0, 1, 0], // L: (x,y,z) -> (x, -z, y)
  [0, -1, 0, 1, 0, 0, 0, 0, 1], // B: (x,y,z) -> (-y, x, z)
];

const eqVec = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function faceOfNormal(n: Vec3): number {
  const f = NORMAL.findIndex((m) => eqVec(m, n));
  if (f < 0) throw new Error(`not a face normal: ${n}`);
  return f;
}

// ---- フェイスターン（18手） ----

export const MOVE_NAMES: string[] = FACES.flatMap((f) => [f, `${f}2`, `${f}'`]);
export const NUM_MOVES = 18;
export const moveFace = (m: number) => Math.floor(m / 3);
export const moveAmount = (m: number) => [1, 2, 3][m % 3]; // 時計回り 90° の回数
export const inverseMove = (m: number) => moveFace(m) * 3 + [2, 1, 0][m % 3];

export function moveIndex(name: string): number {
  const i = MOVE_NAMES.indexOf(name.replace("2'", "2").replace("’", "'"));
  if (i < 0) throw new Error(`unknown move: ${name}`);
  return i;
}

// dest[i] = facelet i のステッカーが移る先
function permFromTransform(selected: (pos: Vec3) => boolean, m: Mat3): Int8Array {
  const dest = new Int8Array(54);
  for (let i = 0; i < 54; i++) {
    const { pos, normal } = GEOMETRY[i];
    dest[i] = selected(pos) ? faceletAt(apply(m, pos), apply(m, normal)) : i;
  }
  return dest;
}

function power(m: Mat3, n: number): Mat3 {
  let out = IDENTITY;
  for (let i = 0; i < n; i++) out = mul(m, out);
  return out;
}

export const MOVE_DEST: Int8Array[] = Array.from({ length: NUM_MOVES }, (_, mi) => {
  const f = moveFace(mi);
  return permFromTransform((p) => dot(p, NORMAL[f]) === 1, power(FACE_TURN[f], moveAmount(mi)));
});

// gather 形式: next[i] = cur[MOVE_SRC[m][i]]（ホットループ用）
export const MOVE_SRC: Int8Array[] = MOVE_DEST.map((dest) => {
  const src = new Int8Array(54);
  for (let i = 0; i < 54; i++) src[dest[i]] = i;
  return src;
});

export type CubeState = Uint8Array;

export function solvedState(): CubeState {
  const s = new Uint8Array(54);
  for (let i = 0; i < 54; i++) s[i] = Math.floor(i / 9);
  return s;
}

export function applyMoveInto(src: CubeState, move: number, dst: CubeState): void {
  const p = MOVE_SRC[move];
  for (let i = 0; i < 54; i++) dst[i] = src[p[i]];
}

export function applyMove(state: CubeState, move: number): CubeState {
  const out = new Uint8Array(54);
  applyMoveInto(state, move, out);
  return out;
}

export function parseMoves(alg: string): number[] {
  return alg
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(moveIndex);
}

export function applyMoves(state: CubeState, moves: number[] | string): CubeState {
  const list = typeof moves === "string" ? parseMoves(moves) : moves;
  let s = state;
  for (const m of list) s = applyMove(s, m);
  return s;
}

export function invertMoves(moves: number[]): number[] {
  return [...moves].reverse().map(inverseMove);
}

export const movesToString = (moves: number[]) => moves.map((m) => MOVE_NAMES[m]).join(" ");

export function isSolved(state: CubeState): boolean {
  for (let f = 0; f < 6; f++) {
    const c = state[f * 9 + 4];
    for (let i = 0; i < 9; i++) if (state[f * 9 + i] !== c) return false;
  }
  return true;
}

export function statesEqual(a: CubeState, b: CubeState): boolean {
  for (let i = 0; i < 54; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---- キューブ全体の姿勢（24通り） ----
// ORIENTATIONS[o] はキューブ固定フレーム → カメラフレームの回転行列。
// カメラフレーム: +x = 画像の右、+y = 画像の上、+z = カメラ側（カメラが見ている面が F）。

export const ROTATION: Record<"x" | "y" | "z", Mat3> = {
  x: FACE_TURN[R],
  y: FACE_TURN[U],
  z: FACE_TURN[F],
};

export const ORIENTATIONS: Mat3[] = (() => {
  const found: Mat3[] = [IDENTITY];
  const seen = new Set([IDENTITY.join()]);
  for (let i = 0; i < found.length; i++) {
    for (const g of [ROTATION.x, ROTATION.y, ROTATION.z]) {
      const m = mul(g, found[i]);
      if (!seen.has(m.join())) {
        seen.add(m.join());
        found.push(m);
      }
    }
  }
  return found;
})();

export const NUM_ORIENTATIONS = ORIENTATIONS.length; // 24

const ORIENT_INDEX = new Map(ORIENTATIONS.map((m, i) => [m.join(), i]));
export const orientationIndex = (m: Mat3): number => {
  const i = ORIENT_INDEX.get(m.join());
  if (i === undefined) throw new Error("not a cube rotation");
  return i;
};

// 姿勢 o のキューブをカメラフレームで rot だけ回した後の姿勢
export function rotateOrientation(o: number, rot: "x" | "y" | "z", times = 1): number {
  return orientationIndex(mul(power(ROTATION[rot], ((times % 4) + 4) % 4), ORIENTATIONS[o]));
}

// VIEW[(o * 6 + c) * 9 + cell] = 姿勢 o のとき、カメラフレームの面 c のセル cell に見えるキューブ固定フレームの facelet
export const VIEW: Uint8Array = (() => {
  const out = new Uint8Array(24 * 6 * 9);
  ORIENTATIONS.forEach((m, o) => {
    const inv = transpose(m);
    for (let c = 0; c < 6; c++) {
      for (let cell = 0; cell < 9; cell++) {
        const g = GEOMETRY[c * 9 + cell]; // カメラフレームで同じ番号付けを使う
        out[(o * 6 + c) * 9 + cell] = faceletAt(apply(inv, g.pos), apply(inv, g.normal));
      }
    }
  });
  return out;
})();

// 姿勢 o のとき、カメラフレームの面 c に来ているキューブ固定フレームの面
export function cubeFaceAt(o: number, c: number): number {
  return Math.floor(VIEW[(o * 6 + c) * 9 + 4] / 9);
}

// キューブ固定フレームの面 f が、姿勢 o のときカメラフレームでどの面にあるか
export function cameraFaceOf(o: number, f: number): number {
  return faceOfNormal(apply(ORIENTATIONS[o], NORMAL[f]));
}

// 姿勢 o のキューブをカメラフレームで見た状態（カメラフレームの facelet 番号で並べたもの）
export function viewState(state: CubeState, o: number): CubeState {
  const out = new Uint8Array(54);
  for (let c = 0; c < 6; c++) for (let cell = 0; cell < 9; cell++) out[c * 9 + cell] = state[VIEW[(o * 6 + c) * 9 + cell]];
  return out;
}

// キューブ固定の手 m を、姿勢 o で持っているときの「持ち方基準」の手に読み替える
export function relativeMove(m: number, o: number): number {
  return cameraFaceOf(o, moveFace(m)) * 3 + (m % 3);
}

// 逆に、持ち方基準の手をキューブ固定の手へ
export function absoluteMove(rel: number, o: number): number {
  return cubeFaceAt(o, moveFace(rel)) * 3 + (rel % 3);
}

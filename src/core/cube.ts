/**
 * CubeVision / core: 3x3 キューブ状態機械
 *
 * このモジュールはカメラ・DOM・時間を一切知らない純粋な状態機械。
 * 依存を足したくなったら設計ミスなので止まること（CLAUDE.md アーキテクチャ原則 §1）。
 *
 * 実装は CLAUDE.md「キューブ状態モデル仕様」の 3D 座標モデルそのまま。
 * facelet の置換テーブルは手書きしない。
 */

export type Vec3 = [number, number, number];

/** 面インデックス。U=0, R=1, F=2, D=3, L=4, B=5（= ステッカーの初期面 = 色ID）。 */
export type FaceIndex = 0 | 1 | 2 | 3 | 4 | 5;

export const FACE_NAMES = ['U', 'R', 'F', 'D', 'L', 'B'] as const;
export type FaceLetter = (typeof FACE_NAMES)[number];

export const U = 0, R = 1, F = 2, D = 3, L = 4, B = 5;

/** 面の外向き法線（CLAUDE.md「面の法線」表）。 */
export const FACE_NORMALS: readonly Vec3[] = [
  [0, 1, 0],   // U
  [1, 0, 0],   // R
  [0, 0, 1],   // F
  [0, -1, 0],  // D
  [-1, 0, 0],  // L
  [0, 0, -1],  // B
];

/** facelet 抽出フレーム（CLAUDE.md「facelet 抽出フレーム」表）。 */
const FACE_ROWDIR: readonly Vec3[] = [
  [0, 0, 1],   // U
  [0, -1, 0],  // R
  [0, -1, 0],  // F
  [0, 0, -1],  // D
  [0, -1, 0],  // L
  [0, -1, 0],  // B
];
const FACE_COLDIR: readonly Vec3[] = [
  [1, 0, 0],   // U
  [0, 0, -1],  // R
  [1, 0, 0],   // F
  [1, 0, 0],   // D
  [0, 0, 1],   // L
  [-1, 0, 0],  // B
];

export interface Sticker {
  /** 現在の法線 */
  n: Vec3;
  /** 初期面 = 色 */
  c: FaceIndex;
}

export interface Cubie {
  /** 位置。各成分 -1 | 0 | 1 */
  p: Vec3;
  stickers: Sticker[];
}

/**
 * キューブ状態。cubies は長さ 27 で posIndex(p) の順に並ぶ（O(1) 参照のため）。
 *
 * **状態はイミュータブルとして扱うこと。** applyMove は新しい状態を返し、
 * 動かないキュービーは参照を共有する。破壊的変更を入れると候補生成が壊れる。
 */
export interface CubeState {
  cubies: Cubie[];
}

/** 位置 → cubies 配列の添字。 */
export function posIndex(p: Vec3): number {
  return (p[0] + 1) * 9 + (p[1] + 1) * 3 + (p[2] + 1);
}

export function faceIndexOf(letter: FaceLetter): FaceIndex {
  const i = FACE_NAMES.indexOf(letter);
  if (i < 0) throw new Error(`unknown face: ${letter}`);
  return i as FaceIndex;
}

// ---------------------------------------------------------------------------
// 回転変換（CLAUDE.md「回転」表）。座標にもステッカー法線にも同じ変換を当てる。
// ---------------------------------------------------------------------------

type Rot = (v: Vec3) => Vec3;

const ROT: Record<FaceLetter, Rot> = {
  U: ([x, y, z]) => [-z, y, x],
  D: ([x, y, z]) => [z, y, -x],
  R: ([x, y, z]) => [x, z, -y],
  L: ([x, y, z]) => [x, -z, y],
  F: ([x, y, z]) => [y, -x, z],
  B: ([x, y, z]) => [-y, x, z],
};

/** そのレイヤに属するか。 */
const IN_LAYER: Record<FaceLetter, (p: Vec3) => boolean> = {
  U: (p) => p[1] === 1,
  D: (p) => p[1] === -1,
  R: (p) => p[0] === 1,
  L: (p) => p[0] === -1,
  F: (p) => p[2] === 1,
  B: (p) => p[2] === -1,
};

/** キューブ全体回転 → 対応する面変換（x=R, y=U, z=F）。 */
const ROTATION_AXIS: Record<'x' | 'y' | 'z', FaceLetter> = { x: 'R', y: 'U', z: 'F' };

// ---------------------------------------------------------------------------
// 記法
// ---------------------------------------------------------------------------

export type MoveLetter = FaceLetter | 'x' | 'y' | 'z';

export interface Move {
  letter: MoveLetter;
  /** 時計回りの回数。1 = 無印, 2 = 2, 3 = プライム */
  amount: 1 | 2 | 3;
  /** 正規化済みトークン（例 "R", "U'", "F2", "y'"） */
  token: string;
}

const MOVE_RE = /^([URFDLBxyz])([2'])?$/;

export function parseMove(raw: string): Move {
  // 全角プライム・アポストロフィ類を正規化。大文字 XYZ も全体回転として受ける。
  let t = raw.trim().replace(/[’ʼ´`]/g, "'");
  if (t.length > 0 && 'XYZ'.includes(t[0])) t = t[0].toLowerCase() + t.slice(1);
  const m = MOVE_RE.exec(t);
  if (!m) throw new Error(`invalid move notation: "${raw}"`);
  const letter = m[1] as MoveLetter;
  const amount: 1 | 2 | 3 = m[2] === '2' ? 2 : m[2] === "'" ? 3 : 1;
  return { letter, amount, token: letter + (amount === 2 ? '2' : amount === 3 ? "'" : '') };
}

export function parseSequence(notation: string): Move[] {
  const tokens = notation.trim().split(/\s+/).filter((s) => s.length > 0);
  return tokens.map(parseMove);
}

export function formatSequence(moves: Move[]): string {
  return moves.map((m) => m.token).join(' ');
}

export function invertMove(m: Move): Move {
  const amount: 1 | 2 | 3 = m.amount === 1 ? 3 : m.amount === 3 ? 1 : 2;
  return { letter: m.letter, amount, token: m.letter + (amount === 2 ? '2' : amount === 3 ? "'" : '') };
}

export function invertSequence(moves: Move[] | string): Move[] {
  const list = typeof moves === 'string' ? parseSequence(moves) : moves;
  return list.slice().reverse().map(invertMove);
}

/** 18 手（面回転のみ）。 */
export const MOVES_18: readonly string[] = FACE_NAMES.flatMap((f) => [f, `${f}'`, `${f}2`]);

/** 6 つの全体回転。 */
export const ROTATIONS_6: readonly string[] = ['x', "x'", 'y', "y'", 'z', "z'"];

// ---------------------------------------------------------------------------
// 状態操作
// ---------------------------------------------------------------------------

export function solvedState(): CubeState {
  const cubies: Cubie[] = new Array(27);
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -1; z <= 1; z++) {
        const p: Vec3 = [x, y, z];
        const stickers: Sticker[] = [];
        for (let f = 0; f < 6; f++) {
          const n = FACE_NORMALS[f];
          if (p[0] * n[0] + p[1] * n[1] + p[2] * n[2] === 1) {
            stickers.push({ n: [n[0], n[1], n[2]], c: f as FaceIndex });
          }
        }
        cubies[posIndex(p)] = { p, stickers };
      }
    }
  }
  return { cubies };
}

export function cloneState(s: CubeState): CubeState {
  return {
    cubies: s.cubies.map((c) => ({
      p: [c.p[0], c.p[1], c.p[2]] as Vec3,
      stickers: c.stickers.map((st) => ({ n: [st.n[0], st.n[1], st.n[2]] as Vec3, c: st.c })),
    })),
  };
}

function applyQuarter(s: CubeState, rot: Rot, inLayer: (p: Vec3) => boolean): CubeState {
  const out: Cubie[] = new Array(27);
  for (let i = 0; i < 27; i++) {
    const c = s.cubies[i];
    if (!inLayer(c.p)) {
      out[i] = c; // 不変なので参照共有でよい
      continue;
    }
    const np = rot(c.p);
    const stickers: Sticker[] = new Array(c.stickers.length);
    for (let k = 0; k < c.stickers.length; k++) {
      const st = c.stickers[k];
      stickers[k] = { n: rot(st.n), c: st.c };
    }
    out[posIndex(np)] = { p: np, stickers };
  }
  return { cubies: out };
}

export function applyMove(s: CubeState, move: string | Move): CubeState {
  const m = typeof move === 'string' ? parseMove(move) : move;
  const isRotation = m.letter === 'x' || m.letter === 'y' || m.letter === 'z';
  const rot = ROT[isRotation ? ROTATION_AXIS[m.letter as 'x' | 'y' | 'z'] : (m.letter as FaceLetter)];
  const inLayer = isRotation ? () => true : IN_LAYER[m.letter as FaceLetter];
  let out = s;
  for (let i = 0; i < m.amount; i++) out = applyQuarter(out, rot, inLayer);
  return out;
}

export function applySequence(s: CubeState, notation: string | Move[]): CubeState {
  const moves = typeof notation === 'string' ? parseSequence(notation) : notation;
  let out = s;
  for (const m of moves) out = applyMove(out, m);
  return out;
}

// ---------------------------------------------------------------------------
// facelet 抽出
// ---------------------------------------------------------------------------

/**
 * 面 f の 9 セルを row-major（row 0..2, col 0..2）で返す。
 * pos = normal + rowdir * (row - 1) + coldir * (col - 1)
 */
export function getFaceletsInto(s: CubeState, face: FaceIndex, out: FaceIndex[]): FaceIndex[] {
  const n = FACE_NORMALS[face];
  const rd = FACE_ROWDIR[face];
  const cd = FACE_COLDIR[face];
  for (let row = 0; row < 3; row++) {
    const dr = row - 1;
    for (let col = 0; col < 3; col++) {
      const dc = col - 1;
      const idx =
        (n[0] + rd[0] * dr + cd[0] * dc + 1) * 9 +
        (n[1] + rd[1] * dr + cd[1] * dc + 1) * 3 +
        (n[2] + rd[2] * dr + cd[2] * dc + 1);
      const cubie = s.cubies[idx];
      let c = -1;
      for (let k = 0; k < cubie.stickers.length; k++) {
        const st = cubie.stickers[k];
        if (st.n[0] === n[0] && st.n[1] === n[1] && st.n[2] === n[2]) {
          c = st.c;
          break;
        }
      }
      if (c < 0) throw new Error(`no sticker facing ${FACE_NAMES[face]} at cubie ${cubie.p.join(',')}`);
      out[row * 3 + col] = c as FaceIndex;
    }
  }
  return out;
}

export function getFacelets(s: CubeState, face: FaceIndex | FaceLetter): FaceIndex[] {
  const f = typeof face === 'string' ? faceIndexOf(face) : face;
  return getFaceletsInto(s, f, new Array(9));
}

/** URFDLB 順に 54 個。Kociemba の facelet 順と同じ並び。 */
export function getAllFacelets(s: CubeState): FaceIndex[] {
  const out: FaceIndex[] = [];
  for (let f = 0; f < 6; f++) out.push(...getFacelets(s, f as FaceIndex));
  return out;
}

export function faceletString(s: CubeState): string {
  return getAllFacelets(s).map((c) => FACE_NAMES[c]).join('');
}

/**
 * 完成判定。各面が単色であることのみを見る = 全体回転に非依存。
 * （持ち替えた状態で揃えても「完成」として計測を止めたいため）
 */
export function isSolved(s: CubeState): boolean {
  const buf: FaceIndex[] = new Array(9);
  for (let f = 0; f < 6; f++) {
    getFaceletsInto(s, f as FaceIndex, buf);
    for (let i = 1; i < 9; i++) if (buf[i] !== buf[0]) return false;
  }
  return true;
}

/**
 * 状態の完全な署名（センターの向きまで含む）。テストと重複検出用。
 */
export function stateSignature(s: CubeState): string {
  const parts: string[] = [];
  for (let i = 0; i < 27; i++) {
    const c = s.cubies[i];
    const st = c.stickers
      .map((x) => `${x.n[0]}${x.n[1]}${x.n[2]}:${x.c}`)
      .sort()
      .join(',');
    parts.push(`${c.p.join('')}|${st}`);
  }
  return parts.join(';');
}

export function statesEqual(a: CubeState, b: CubeState): boolean {
  return stateSignature(a) === stateSignature(b);
}

// ---------------------------------------------------------------------------
// スクランブル生成
// ---------------------------------------------------------------------------

const AXIS_OF: Record<FaceLetter, number> = { R: 0, L: 0, U: 1, D: 1, F: 2, B: 2 };

export type Rng = () => number;

/**
 * ランダムスクランブル生成。連続同軸を排除する（R L R のような並びも出ない）。
 * WCA 公式スクランブラではない。フェーズ0の検証用。
 */
export function generateScramble(length = 20, rng: Rng = Math.random): string {
  const out: string[] = [];
  let lastAxis = -1;
  while (out.length < length) {
    const face = FACE_NAMES[Math.floor(rng() * 6)];
    const axis = AXIS_OF[face];
    if (axis === lastAxis) continue;
    const suffix = ['', "'", '2'][Math.floor(rng() * 3)];
    out.push(face + suffix);
    lastAxis = axis;
  }
  return out.join(' ');
}

/** テスト用の決定的 RNG（mulberry32）。 */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

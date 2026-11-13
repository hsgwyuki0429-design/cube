// ピースごとのキューブの表し方（精密解析の「ピースの時刻表」: table.ts・solve.ts）。
// ステッカーは 54 枚あるが、動くのは 20 個のピース（コーナー 8・エッジ 12）で、ピースの「どこに・どの向きで」あるかは
// 代表のステッカー（ピースの中で facelet 番号が一番小さいもの）のある facelet 1 つで決まる（コーナー・エッジとも 24 通り）。
// 手はこの 24 通りの置換なので、状態 = 20 個の facelet 番号、1 手 = 表を 20 回引くだけ。ピースどうしは独立に動く。
// センターは動かないが、その面を回すと 90° ずつ回る: マーカーの向きから「その面を合わせて何回回したか（4 で割った余り）」が読める。
// DOM もカメラも知らない
import { COLDIR, type CubeState, FACE_TURN, MOVE_DEST, NORMAL, NUM_MOVES, ORIENTATIONS, ROWDIR, type Vec3, apply, faceletAt, faceletGeometry, mul, rotateOrientation, transpose } from "../../cube/model";
import { PARTNERS, stickerIds } from "../../cube/stickers";

export const NUM_PIECES = 20;

// facelet → ピースの番号（センターは -1）と、ピースの中での順番（0 = 代表。PARTNERS の並びの順）
export const PIECE_OF = new Int8Array(54).fill(-1);
// ピース → 代表のステッカー（揃った状態での facelet）
export const PIECE_REF: number[] = [];
// ピースがコーナーか
export const IS_CORNER: boolean[] = [];
for (let i = 0; i < 54; i++) {
  if (PARTNERS[i].length === 0 || PIECE_OF[i] >= 0) continue;
  const k = PIECE_REF.length;
  PIECE_REF.push(i);
  IS_CORNER.push(PARTNERS[i].length === 2);
  PIECE_OF[i] = k;
  for (const j of PARTNERS[i]) PIECE_OF[j] = k;
}

// REF_AT[s * 54 + p]: ステッカー s が facelet p にあるとき、同じピースの代表のステッカーがある facelet（ありえない組は -1）
export const REF_AT = new Int8Array(54 * 54).fill(-1);
// STICKER_AT[piece * 54 + x]: ピースの代表が facelet x にあるとき… は下の stickerOf で求める
for (let s = 0; s < 54; s++) {
  const ps = PARTNERS[s];
  if (!ps.length) continue;
  const ring = [s, ...ps];
  const ref = PIECE_REF[PIECE_OF[s]];
  const k = ring.indexOf(ref);
  for (let p = 0; p < 54; p++) {
    if (PARTNERS[p].length !== ps.length) continue;
    REF_AT[s * 54 + p] = [p, ...PARTNERS[p]][k];
  }
}

// 手の置換（facelet → 移る先）。ピースの代表の位置にそのまま使う
export const PERM: Uint8Array[] = MOVE_DEST.map((d) => Uint8Array.from(d));

// LAYER_BIT[x]: facelet x のピースが入っている層（面 U R F D L B のビット）
export const LAYER_BIT = new Uint8Array(54);
for (let x = 0; x < 54; x++) {
  const { pos } = faceletGeometry(x);
  for (let f = 0; f < 6; f++) if (pos[0] * NORMAL[f][0] + pos[1] * NORMAL[f][1] + pos[2] * NORMAL[f][2] === 1) LAYER_BIT[x] |= 1 << f;
}

// DIST[x * 54 + y]: ピースを x から y へ運ぶのに要る、そのピースを動かす手の最小の数（同じ種類の facelet どうし。0〜3。届かない組は 9）
export const DIST = new Uint8Array(54 * 54).fill(9);
for (let x = 0; x < 54; x++) {
  if (!PARTNERS[x].length) continue;
  DIST[x * 54 + x] = 0;
  let frontier = [x];
  for (let d = 1; frontier.length; d++) {
    const next: number[] = [];
    for (const a of frontier)
      for (let m = 0; m < NUM_MOVES; m++) {
        const b = PERM[m][a];
        if (DIST[x * 54 + b] === 9) {
          DIST[x * 54 + b] = d;
          next.push(b);
        }
      }
    frontier = next;
  }
}

// ---- マーカーの向き ----
// ステッカーは、揃った状態でマーカーの上辺が面の行 0 の側を向くように貼ってある。
// 向きは「格子の上（行 0 の側）= 0・右 = 1・下 = 2・左 = 3」（外から見て時計回りに増える）
const DIRS = (f: number): Vec3[] => [ROWDIR[f].map((v) => -v) as Vec3, COLDIR[f], ROWDIR[f], COLDIR[f].map((v) => -v) as Vec3];
const same = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const frameOf = (i: number): number[] => {
  // facelet i のピースに固定した直交基底（列ベクトル）: 自分の法線・相手の 1 つ目の法線・その外積
  const n = faceletGeometry(i).normal;
  const n1 = faceletGeometry(PARTNERS[i][0]).normal;
  const c = cross(n, n1);
  return [n[0], n1[0], c[0], n[1], n1[1], c[1], n[2], n1[2], c[2]];
};

// EXPECT_ROT[s * 54 + q]: ステッカー s（コーナー・エッジ）が facelet q にあるときの、マーカーの向き（q の面の格子に対して）。
// カメラの面のマスの並びはキューブの面と同じ表なので、q をカメラフレームの facelet（スロット * 9 + マス）としても同じ値
export const EXPECT_ROT = new Int8Array(54 * 54).fill(-1);
for (let s = 0; s < 54; s++) {
  if (!PARTNERS[s].length) continue;
  const up = DIRS(Math.floor(s / 9))[0];
  const inv = transpose(frameOf(s));
  for (let q = 0; q < 54; q++) {
    if (PARTNERS[q].length !== PARTNERS[s].length) continue;
    const v = apply(mul(frameOf(q), inv), up);
    EXPECT_ROT[s * 54 + q] = DIRS(Math.floor(q / 9)).findIndex((d) => same(d, v));
  }
}

// CENTER_BASE[o * 6 + slot]: 姿勢 o で、カメラの面 slot に見えるセンターの、1 回も回していないときのマーカーの向き。
// 読んだ向き − これ（4 で割った余り）= その面を時計回りに 90° 回した回数
export const CENTER_BASE = new Int8Array(24 * 6);
ORIENTATIONS.forEach((m, o) => {
  const inv = transpose(m);
  for (let c = 0; c < 6; c++) {
    const n = apply(inv, NORMAL[c]); // カメラの面 c に来ているキューブの面の法線
    const f = NORMAL.findIndex((x) => same(x, n));
    const v = apply(m, DIRS(f)[0]);
    CENTER_BASE[o * 6 + c] = DIRS(c).findIndex((d) => same(d, v));
  }
});

// ---- 状態 ----
// pos[k] = ピース k の代表のステッカーがある facelet。turns[f] = 面 f を時計回りに回した回数（4 で割った余り）
export interface PieceState {
  pos: Uint8Array; // 20
  turns: Uint8Array; // 6
}

export function fromCubeState(state: CubeState): PieceState {
  const ids = stickerIds(state);
  const pos = new Uint8Array(NUM_PIECES);
  for (let f = 0; f < 54; f++) {
    const s = ids[f];
    if (s < 0) throw new Error("ありえない状態");
    const k = PIECE_OF[s];
    if (k >= 0 && PIECE_REF[k] === s) pos[k] = f;
  }
  return { pos, turns: new Uint8Array(6) };
}

export function toCubeState(pos: ArrayLike<number>): CubeState {
  const out = new Uint8Array(54);
  for (let f = 0; f < 6; f++) out[f * 9 + 4] = f;
  for (let k = 0; k < NUM_PIECES; k++) {
    const ref = PIECE_REF[k];
    const home = [ref, ...PARTNERS[ref]];
    const at = [pos[k], ...PARTNERS[pos[k]]];
    for (let j = 0; j < home.length; j++) out[at[j]] = Math.floor(home[j] / 9);
  }
  return out;
}

// USEFUL[x * 54 + y]: ピースを x から y へ運ぶとき、1 手目になれる手（その手で y までの距離が縮む。18 ビット）
export const USEFUL = new Uint32Array(54 * 54);
// TOUCH[x]: facelet x のピースを動かす手（18 ビット）
export const TOUCH = new Uint32Array(54);
for (let x = 0; x < 54; x++) {
  if (!PARTNERS[x].length) continue;
  for (let m = 0; m < NUM_MOVES; m++) if (PERM[m][x] !== x) TOUCH[x] |= 1 << m;
  for (let y = 0; y < 54; y++) {
    const d = DIST[x * 54 + y];
    if (d === 0 || d === 9) continue;
    for (let m = 0; m < NUM_MOVES; m++) if (DIST[PERM[m][x] * 54 + y] < d) USEFUL[x * 54 + y] |= 1 << m;
  }
}

// NEAR[o * 24 + p]: 姿勢 p は、姿勢 o のキューブをカメラの軸のどれかのまわりに 90° 回したもの。
// キューブを傾けると、認識は見えている面を別のスロットに割り当て直す（上の面が正面になる、など）。そのときの姿勢の変わり方
export const NEAR = new Uint8Array(24 * 24);
for (let o = 0; o < 24; o++) for (const ax of ["x", "y", "z"] as const) for (const n of [1, 3]) NEAR[o * 24 + rotateOrientation(o, ax, n)] = 1;

// ---- 面の置き方（スロットに頼らない: table.ts） ----
// 面の辺: 0 = 上（行 0 の側）・1 = 右（列 2 の側）・2 = 下・3 = 左。NEIGHBOR[F * 4 + k] = 面 F の辺 k で接する面 F' と、F' の側の辺 k'（F' * 4 + k'）
const SIDE_CELL = [1, 5, 7, 3];
export const NEIGHBOR = new Uint8Array(24);
for (let f = 0; f < 6; f++)
  for (let k = 0; k < 4; k++) {
    const p = PARTNERS[f * 9 + SIDE_CELL[k]][0];
    NEIGHBOR[f * 4 + k] = Math.floor(p / 9) * 4 + SIDE_CELL.indexOf(p % 9);
  }
// CELL_TURN[r * 9 + c]: 読んだ格子のマス c が、面の決まった並びではどのマスか。r = 面の決まった並びの上の辺が、格子のどの辺にあるか
// （格子は決まった並びを時計回りに r × 90° 回したもの）。マーカーの向きは 格子での向き − r
export const CELL_TURN = new Uint8Array(36);
for (let r = 0; r < 4; r++)
  for (let c = 0; c < 9; c++) {
    let row = Math.floor(c / 3);
    let col = c % 3;
    for (let i = 0; i < r; i++) [row, col] = [2 - col, row];
    CELL_TURN[r * 9 + c] = row * 3 + col;
  }

// WHOLE[(x * 4 + d) * 54 + p]: キューブ全体を面 x の法線のまわりに d × 90°（その面を回すのと同じ向き）回したとき、facelet p が移る先。
// センターが 1 つだけ読めたフレームの「ほかの置き方」（その面のまわりの 4 通り）は、ピースの位置をこれで移したもの
export const WHOLE = new Uint8Array(24 * 54);
for (let x = 0; x < 6; x++) {
  let m: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let d = 0; d < 4; d++) {
    for (let p = 0; p < 54; p++) {
      const g = faceletGeometry(p);
      WHOLE[(x * 4 + d) * 54 + p] = faceletAt(apply(m, g.pos), apply(m, g.normal));
    }
    m = mul(FACE_TURN[x], m);
  }
}

// ROT24[r * 54 + p]: キューブ全体の回転 24 通り（r = 0 は回さない）で facelet p が移る先。
// センターが 1 つも読めないフレームは、キューブのどの面かが分からない: ピースの位置をこれで移した 24 通りの置き方のどれか
export const ROT24: Uint8Array = (() => {
  const key = (a: Uint8Array) => a.join();
  const id = Uint8Array.from({ length: 54 }, (_, i) => i);
  const found = [id];
  const seen = new Set([key(id)]);
  for (let i = 0; i < found.length; i++)
    for (const x of [0, 1, 2]) {
      const g = WHOLE.subarray((x * 4 + 1) * 54, (x * 4 + 2) * 54);
      const c = Uint8Array.from(found[i], (v) => g[v]);
      if (!seen.has(key(c))) {
        seen.add(key(c));
        found.push(c);
      }
    }
  const out = new Uint8Array(24 * 54);
  found.forEach((a, r) => out.set(a, r * 54));
  return out;
})();

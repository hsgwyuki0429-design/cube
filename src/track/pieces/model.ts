// ピースごとのキューブの表し方（精密解析の「ステッカーの動きの方程式」: table.ts・decode.ts）。
// ステッカーは 54 枚あるが、動くのは 20 個のピース（コーナー 8・エッジ 12）で、ピースの「どこに・どの向きで」あるかは
// 代表のステッカー（ピースの中で facelet 番号が一番小さいもの）のある facelet 1 つで決まる（コーナー・エッジとも 24 通り）。
// 「ステッカー a がマス b に見えた」は「ピース PIECE_OF[a] の代表が REF_AT[a * 54 + b] にある」という式 1 本になり、同じピースの
// ステッカーは同じ式になる（F2 が U8 に見えた ⇔ U8 の相手 R… ではなく、F2 のピースの代表がある所が 1 つに決まる）。
// 手はこの 24 通りの置換なので、状態 = 20 個の facelet 番号、1 手 = 表を 20 回引くだけ。ピースどうしは独立に動く。
// DOM もカメラも知らない
import { type CubeState, FACE_TURN, MOVE_DEST, NORMAL, NUM_MOVES, ROWDIR, COLDIR, type Vec3, apply, faceletAt, faceletGeometry, mul, transpose } from "../../cube/model";
import { PARTNERS, stickerIds } from "../../cube/stickers";

export const NUM_PIECES = 20;

// facelet → ピースの番号（センターは -1）
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
// STICKER_AT[s * 54 + x]: ステッカー s のピースの代表が facelet x にあるとき、s がある facelet（ありえない組は -1）。REF_AT の逆
export const STICKER_AT = new Int8Array(54 * 54).fill(-1);
for (let s = 0; s < 54; s++) for (let p = 0; p < 54; p++) if (REF_AT[s * 54 + p] >= 0) STICKER_AT[s * 54 + REF_AT[s * 54 + p]] = p;

// 手の置換（facelet → 移る先）。ピースの代表の位置にそのまま使う
export const PERM: Uint8Array[] = MOVE_DEST.map((d) => Uint8Array.from(d));

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

// TOUCH[x]: facelet x のピースを動かす手（18 ビット）
export const TOUCH = new Uint32Array(54);
for (let x = 0; x < 54; x++) {
  if (!PARTNERS[x].length) continue;
  for (let m = 0; m < NUM_MOVES; m++) if (PERM[m][x] !== x) TOUCH[x] |= 1 << m;
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

// EXPECT_ROT[s * 54 + q]: ステッカー s（コーナー・エッジ）が facelet q にあるときの、マーカーの向き（q の面の格子に対して）
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

// ---- 状態 ----
// pos[k] = ピース k の代表のステッカーがある facelet
export function piecesOf(state: CubeState): Uint8Array {
  const ids = stickerIds(state);
  const pos = new Uint8Array(NUM_PIECES);
  for (let f = 0; f < 54; f++) {
    const s = ids[f];
    if (s < 0) throw new Error("ありえない状態");
    const k = PIECE_OF[s];
    if (k >= 0 && PIECE_REF[k] === s) pos[k] = f;
  }
  return pos;
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

// COLOR_OF[x * 54 + q]: 代表が facelet x にあるピースが facelet q に見せる色（そのピースのステッカーが q になければ -1）。
// ピース k の代表が x にあるとき、q の色 = COLOR_OF[(PIECE_REF[k] の並び) …] は代表の位置と q だけでは決まらない（どのピースかで違う）ので、
// ピースごとに引く: pieceColorAt(k, x, q)
export function pieceColorAt(k: number, x: number, q: number): number {
  const ref = PIECE_REF[k];
  const home = [ref, ...PARTNERS[ref]];
  const at = [x, ...PARTNERS[x]];
  const j = at.indexOf(q);
  return j < 0 ? -1 : Math.floor(home[j] / 9);
}

// WHOLE[(x * 4 + d) * 54 + p]: キューブ全体を面 x の法線のまわりに d × 90°（その面を回すのと同じ向き）回したとき、facelet p が移る先。
// センターが 1 つだけ読めたフレームの「ほかの置き方」（その面のまわりの 4 通り）は、読みの位置をこれで移したもの
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

// 面 f の法線
export const faceNormal = (f: number): Vec3 => NORMAL[f];

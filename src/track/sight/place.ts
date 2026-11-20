// 読みの置き方（新しい追跡の入口）: 1 フレームの読みを「ステッカー s が、キューブ固定の facelet p に、確かさの種類 c で見えた」に直す。
// 認識の出すスロット（正面・上・右…）には頼らない。面の中のマスの並びと、
//   - センターの ID = その面がキューブのどの面か
//   - 面どうしが画像の上でどの辺で接しているか（外枠の辺が重なる。src/track/pieces/table.ts の touching・placeAll）
// だけで置き方を決める。センターが 2 つ読めれば置き方は 1 つに決まる（実物の T-perm 2 本で、そのフレームの読みの誤り 0）。
// センターが 1 つだけなら、その面の法線まわりの 4 通りが残る: 面の決まった並びの「上」が画像で向く角度が、前の「置き方の決まった
// フレーム」から続くものを選び、残りの 3 通りもコストつきで候補に残す（追跡器が状態ごとに一番合うものを選ぶ）。センターが 1 つも
// 読めなければ 24 通りすべてを候補にする（コストつき）。前のフレームしか使わない（ライブでもそのまま使える）。
// DOM もカメラも知らない
import type { SightFace } from "../pieces/frame";
import { CELL_TURN, EXPECT_ROT, NUM_PIECES, PIECE_OF, REF_AT } from "../pieces/model";
import { type Placed, faceUp, isCenter as isCenterId, placeAll, touching, upAngle } from "../pieces/table";

// 読みの確かさの種類（誤読の率が 1〜2 桁違う: CLAUDE.md「本当の誤読」）
export const CLS_DIRECT = 0; // マーカーを直接読んだマス・4 マス以上直接読めた面
export const CLS_DIRECT_FRAG = 1; // マーカーを直接読んだマス・1〜3 マスの欠片
export const CLS_CARRIED = 2; // 前のフレームから引き継いだ ID など（直接読んでいない）・4 マス以上の面
export const CLS_CARRIED_FRAG = 3; // 引き継いだ ID の欠片
export const NUM_CLS = 4;

export const KIND_SURE = 0; // センター 2 つ以上と面の接し方で置き方が 1 つに決まった
export const KIND_CHAINED = 1; // センター 1 つ: 前の置き方の決まったフレームから向きが続くものを選んだ
export const KIND_FREE = 2; // センター 1 つ: 続きが分からない（4 通りが同じコスト）
export const KIND_BLIND = 3; // センターが読めない: 24 通り

export interface PlacedRead {
  piece: number; // 0〜19
  at: number; // ピースの代表のステッカーがある facelet（キューブ固定）
  cls: number;
  sticker: number; // 読んだステッカー（揃った状態での facelet 番号）
  facelet: number; // 見えた facelet（キューブ固定）
}

export interface Placement {
  cost: number; // この置き方の事前のコスト（決まった置き方 0）
  reads: PlacedRead[];
  centerTurns: number[]; // 面ごとのセンターのマーカーの向き（その面を回した回数 mod 4。読めなければ -1）
  faces: (Placed | null)[]; // 読みの面ごとの置き方
}

export interface PlacedFrame {
  t: number;
  kind: number;
  cands: Placement[]; // cost の小さい順。先頭がいちばん確からしい置き方
  slots: number[]; // 読みの面ごとの認識のスロット（調べる用）
  dropped: number; // 置き方とマーカーの向きが合わず捨てた読み
}

export interface PlaceInput {
  t: number;
  faces: { slot: number; ids: number[]; w?: number[]; weight?: number[]; rot?: number[]; quad?: number[]; held?: boolean }[];
}

export interface PlaceOptions {
  touch: number; // 外枠の辺がこれ（辺の長さに対する割合）より近ければ接している
  orientMs: number; // 置き方の決まったフレームの向きを引き継ぐ時間
  bigFace: number; // 直接読んだマスがこれ以上の面は「面」、少なければ「欠片」
  altCost: number; // センター 1 つで、向きの続きと合わない置き方のコスト
  freeCost: number; // センター 1 つで、続きが分からないときの各置き方のコスト
  blindCost: number; // センターが読めないときの各置き方のコスト
  blindMin: number; // センターが読めないフレームは、ID の読めたマスがこれ以上のときだけ使う
  directW: number; // 認識の重みがこれ以上なら直接読んだとみなす（マーカーの向きがない読み）
}

export const DEFAULT_PLACE: PlaceOptions = { touch: 0.45, orientMs: 1500, bigFace: 4, altCost: 3, freeCost: 0.5, blindCost: 1, blindMin: 4, directW: 0.85 };

interface Face {
  slot: number;
  ids: number[];
  rot: number[];
  direct: boolean[];
  quad: number[];
  count: number; // 直接読んだマス
}

export class Placer {
  options: PlaceOptions;
  private angle = new Float64Array(6).fill(Number.NaN); // キューブの面ごとの「上」の画像での角度（置き方の決まったフレームのもの）
  private seen = new Float64Array(6).fill(Number.NaN);

  constructor(options: Partial<PlaceOptions> = {}) {
    this.options = { ...DEFAULT_PLACE, ...options };
  }

  reset(): void {
    this.angle.fill(Number.NaN);
    this.seen.fill(Number.NaN);
  }

  push(input: PlaceInput): PlacedFrame | null {
    const opt = this.options;
    const fs: Face[] = [];
    for (const f of input.faces) {
      if (f.held || !f.quad || f.quad.length !== 8) continue;
      const w = f.w ?? f.weight;
      const rot = f.rot ?? new Array(9).fill(-1);
      const direct = f.ids.map((id, c) => id >= 0 && rot[c] >= 0 && (w?.[c] ?? 1) >= opt.directW);
      const any = f.ids.some((id) => id >= 0);
      if (!any) continue;
      fs.push({ slot: f.slot, ids: f.ids, rot, direct, quad: f.quad, count: direct.filter(Boolean).length });
    }
    if (!fs.length) return null;
    const sfs = fs as unknown as SightFace[];
    // 面どうしの接し方（a, b, a の辺, b の辺）
    const links: number[][] = [];
    for (let a = 0; a < fs.length; a++)
      for (let b = a + 1; b < fs.length; b++) {
        let best = Infinity;
        let bi = 0;
        let bj = 0;
        for (let i = 0; i < 4; i++)
          for (let j = 0; j < 4; j++) {
            const d = touching(fs[a].quad, fs[b].quad, i, j);
            if (d < best) {
              best = d;
              bi = i;
              bj = j;
            }
          }
        if (best < opt.touch) links.push([a, b, bi, bj]);
      }
    // 基準の面: センターを直接読めた面のうち、直接読んだマスがいちばん多いもの
    let root = -1;
    let any = 0;
    for (let i = 0; i < fs.length; i++) {
      if (fs[i].count + fs[i].ids.filter((x) => x >= 0).length > fs[any].count + fs[any].ids.filter((x) => x >= 0).length) any = i;
      const c = fs[i].ids[4];
      if (c < 0 || !fs[i].direct[4] || !isCenterId(c)) continue;
      if (root < 0 || fs[i].count > fs[root].count) root = i;
    }
    const slots = fs.map((f) => f.slot);
    const dropped = { n: 0 };
    if (root < 0) {
      const n = fs.reduce((s, f) => s + f.ids.filter((x) => x >= 0).length, 0);
      if (n < opt.blindMin) return null;
      const cands: Placement[] = [];
      for (let k = 0; k < 24; k++) {
        const placed = placeAll(sfs, links, any, k >> 2, k & 3);
        if (!placed) continue;
        const p = this.read(fs, placed, opt.blindCost, null);
        if (p.reads.length) cands.push(p);
      }
      if (!cands.length) return null;
      return { t: input.t, kind: KIND_BLIND, cands, slots, dropped: 0 };
    }
    const face0 = Math.floor(fs[root].ids[4] / 9);
    const options = [0, 1, 2, 3].map((r) => placeAll(sfs, links, root, face0, r));
    const valid = [0, 1, 2, 3].filter((r) => options[r]);
    if (!valid.length) return null;
    const angleOf = (i: number, r: number) => (fs[i].count >= opt.bigFace ? upAngle(fs[i].quad, r) : faceUp(sfs, links, i, r));
    if (valid.length === 1) {
      const placed = options[valid[0]]!;
      // 向きの基準を更新する（置き方の決まったフレームだけ）
      for (let i = 0; i < fs.length; i++) {
        const pl = placed[i];
        if (!pl) continue;
        this.angle[pl.face] = angleOf(i, pl.r);
        this.seen[pl.face] = input.t;
      }
      const p = this.read(fs, placed, 0, dropped);
      return { t: input.t, kind: KIND_SURE, cands: [p], slots, dropped: dropped.n };
    }
    // センター 1 つ: 向きの続き
    let bestR = -1;
    let best = -Infinity;
    for (const r of valid) {
      const placed = options[r]!;
      let score = 0;
      let used = false;
      for (let i = 0; i < fs.length; i++) {
        const pl = placed[i];
        if (!pl || Number.isNaN(this.angle[pl.face]) || input.t - this.seen[pl.face] > opt.orientMs) continue;
        score += Math.max(1, fs[i].count) * Math.cos(angleOf(i, pl.r) - this.angle[pl.face]);
        used = true;
      }
      if (used && score > best) {
        best = score;
        bestR = r;
      }
    }
    const cands: Placement[] = [];
    for (const r of valid) {
      const cost = bestR < 0 ? opt.freeCost : r === bestR ? 0 : opt.altCost;
      const p = this.read(fs, options[r]!, cost, r === bestR || bestR < 0 ? dropped : null);
      if (p.reads.length || r === bestR) cands.push(p);
    }
    cands.sort((a, b) => a.cost - b.cost);
    return { t: input.t, kind: bestR < 0 ? KIND_FREE : KIND_CHAINED, cands, slots, dropped: dropped.n };
  }

  // 置き方 placed で読みをキューブ固定の facelet に直す。直接読んだマスは、マーカーの向きがその facelet にあるときの向きと合うこと。
  // 同じピースが 2 か所に読めたら、どちらも使わない
  private read(fs: Face[], placed: (Placed | null)[], cost: number, dropped: { n: number } | null): Placement {
    const reads: PlacedRead[] = [];
    const centerTurns = new Array<number>(6).fill(-1);
    const seenPiece = new Map<number, number>();
    const bad = new Set<number>();
    for (let i = 0; i < fs.length; i++) {
      const pl = placed[i];
      if (!pl) continue;
      const f = fs[i];
      const big = f.count >= this.options.bigFace;
      for (let c = 0; c < 9; c++) {
        const s = f.ids[c];
        if (s < 0) continue;
        const cell = CELL_TURN[pl.r * 9 + c];
        const facelet = pl.face * 9 + cell;
        if (isCenterId(s)) {
          if (cell !== 4 || Math.floor(s / 9) !== pl.face) {
            if (dropped) dropped.n++;
            continue;
          }
          if (f.direct[c]) centerTurns[pl.face] = (f.rot[c] - pl.r + 4) & 3;
          continue;
        }
        const at = REF_AT[s * 54 + facelet];
        if (at < 0 || (f.direct[c] && EXPECT_ROT[s * 54 + facelet] !== ((f.rot[c] - pl.r + 4) & 3))) {
          if (dropped) dropped.n++;
          continue;
        }
        const piece = PIECE_OF[s];
        const prev = seenPiece.get(piece);
        if (prev !== undefined) {
          if (reads[prev].at !== at) bad.add(piece);
          continue;
        }
        seenPiece.set(piece, reads.length);
        reads.push({ piece, at, sticker: s, facelet, cls: f.direct[c] ? (big ? CLS_DIRECT : CLS_DIRECT_FRAG) : big ? CLS_CARRIED : CLS_CARRIED_FRAG });
      }
    }
    const out = bad.size ? reads.filter((r) => !bad.has(r.piece)) : reads;
    if (dropped) dropped.n += reads.length - out.length;
    return { cost, reads: out, centerTurns, faces: placed };
  }
}

export { NUM_PIECES };

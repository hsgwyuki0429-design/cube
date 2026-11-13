// ピースの時刻表: フレームごとの読み（frame.ts）を「どのピースが・いつ・どこに（どの向きで）見えたか」に直す。
// 認識の出す面のスロット（上・右・正面…）と格子の向きには頼らない（キューブを傾けたとき・層を回している途中に、面の中身は正しいのに
// スロットや格子の向きだけが狂うフレームがあった）。面の中のマスの並びと、次の 2 つだけを使う:
//   - センターの ID = その面がキューブのどの面か
//   - 面どうしが画像の上でどの辺で接しているか（外枠の辺が重なる）= 面の向き。センターが 2 つ読めれば、置き方は 1 つに決まる
// センターが 1 つだけのフレームは、その面の法線まわりの 4 通りが残る。面の決まった並びの「上」が画像でどちらを向くかが前のフレームと
// 続くもの（キューブはめったに回らない）を仮に選び、残りの 3 通りも表に残す（solve.ts が仮説ごとに選ぶ。持ち替えのコストつき）。
// 使う読みはマーカーを直接読んだマスだけで、マーカーの向きがその ID のステッカーがそのマスにあるときの向きと合うこと。
// センターのマーカーの向きからは、その面を合わせて何回回したか（4 で割った余り）が分かる。
// 同じピースが同じ所に続けて見えた読みは 1 つの「連なり」: 1〜2 枚だけの連なりは重みを下げる（1 枚だけ狂ったフレーム）。
// DOM もカメラも知らない
import { VIEW } from "../../cube/model";
import type { SightFace, SightFrame } from "./frame";
import { CELL_TURN, EXPECT_ROT, NEIGHBOR, NUM_PIECES, PIECE_OF, REF_AT } from "./model";

export interface TableOptions {
  orientMs: number; // 面の向きを前のフレームから引き継ぐ時間
  centerMinRun: number; // センターの向きは、これだけ続けて同じに読めたものだけ使う
  touch: number; // 2 つの面の外枠の辺がこれ（辺の長さに対する割合）より近ければ、その辺で接している
  // センターが 1 つも読めないフレーム（仮の置き方。置き方の決まったフレームとして使うと、持ち替えの途中で取り違えて、実物のソルブ 1 本で
  // 終わりの手順を間違えた。解くときは 24 通りの置き方のどれでもよいことにする: decode.ts）:
  // いちばん読めた面のマスがこれ以上・前後 blindMs 以内に見えていたピースの位置と blindMatch 個以上合い、
  // 2 番目の置き方より blindMargin 個以上多く合うときだけ使う
  blindCells: number;
  blindMs: number;
  blindMatch: number;
  blindMargin: number;
}

export const DEFAULT_TABLE: TableOptions = { orientMs: 1500, centerMinRun: 2, touch: 0.45, blindCells: 4, blindMs: 400, blindMatch: 4, blindMargin: 3 };

export const KIND_SURE = 0; // 置き方がセンターと面の接し方だけで決まった
export const KIND_CHAINED = 1; // センターが 1 つ: 前のフレームから向きが続くものを仮に選んだ
export const KIND_FREE = 2; // センターが 1 つで、続きも分からない（どの置き方もただ）
export const KIND_BLIND = 3; // センターが 1 つも読めない: 前後のピースの位置といちばん合う置き方を仮に選んだ（24 通りのどれでもありうる）

export interface PieceTable {
  n: number; // フレームの数
  t: Float64Array; // フレームの時刻
  kind: Uint8Array;
  root: Int8Array; // 置き方の基準にした面（センターの読めた面）。ほかの置き方は、この面の法線まわりに回したもの
  orient: Int8Array; // 認識のスロットと合う姿勢（手の時刻の判定用: timing.ts。合わなければ -1）
  // フレーム f の読みは first[f] 〜 first[f + 1] − 1
  first: Int32Array;
  piece: Uint8Array; // ピース（0〜19）。センターは 20 + 面
  at: Uint8Array; // ピースの代表のある facelet。センターは回した回数（0〜3）
  solid: Uint8Array; // 2 枚以上続けて同じ所に見えた読み（1 枚だけの読みは使わない: 格子の向き・面の割り当てが 1 枚だけ狂ったフレーム）
  stats: { frames: number; used: number; sure: number; chained: number; free: number; noCenter: number; blind: number; clash: number; dropped: number; sightings: number };
}

const isCenter = (id: number) => id % 9 === 4;
type Pt = [number, number];

// 面 a の辺 i と面 b の辺 j が重なっているか（外枠は左上から時計回り。接する辺は逆向きに重なる）。重なりの悪さ（辺の長さに対する割合）
function touching(a: number[], b: number[], i: number, j: number): number {
  const p = (q: number[], k: number): Pt => [q[(k & 3) * 2], q[(k & 3) * 2 + 1]];
  const d = (u: Pt, v: Pt) => Math.hypot(u[0] - v[0], u[1] - v[1]);
  const a0 = p(a, i);
  const a1 = p(a, i + 1);
  const b0 = p(b, j);
  const b1 = p(b, j + 1);
  return (d(a0, b1) + d(a1, b0)) / (d(a0, a1) + d(b0, b1));
}

// 面の決まった並びの「上」（格子の辺 r）が画像で向く角度
function upAngle(q: number[], r: number): number {
  const cx = (q[0] + q[2] + q[4] + q[6]) / 4;
  const cy = (q[1] + q[3] + q[5] + q[7]) / 4;
  const i = (r & 3) * 2;
  const j = ((r + 1) & 3) * 2;
  return Math.atan2((q[i + 1] + q[j + 1]) / 2 - cy, (q[i] + q[j]) / 2 - cx);
}
// 面 i（置き方 r）の決まった並びの「上」が画像で向く角度。接している面があれば、面 i の真ん中からその面の接している辺の真ん中への
// 向きから求める（面 i を回している途中は、面 i の格子は回る面に付いていくので、自分の格子の辺では 45° 近くまで狂う。隣の面の辺は動かない）
function faceUp(fs: SightFace[], links: number[][], i: number, r: number): number {
  const q = fs[i].quad;
  const cx = (q[0] + q[2] + q[4] + q[6]) / 4;
  const cy = (q[1] + q[3] + q[5] + q[7]) / 4;
  let sx = 0;
  let sy = 0;
  for (const [a, b, sa, sb] of links) {
    if (a !== i && b !== i) continue;
    const o = fs[a === i ? b : a].quad;
    const so = a === i ? sb : sa;
    const k = ((a === i ? sa : sb) - r + 4) & 3; // 面 i の決まった並びで、接している辺
    const u = (so & 3) * 2;
    const v = ((so + 1) & 3) * 2;
    const ang = Math.atan2((o[u + 1] + o[v + 1]) / 2 - cy, (o[u] + o[v]) / 2 - cx) - (k * Math.PI) / 2;
    sx += Math.cos(ang);
    sy += Math.sin(ang);
  }
  return sx || sy ? Math.atan2(sy, sx) : upAngle(q, r);
}

interface Placed {
  face: number; // キューブの面
  r: number; // 面の決まった並びの上の辺が、格子のどの辺にあるか
}

export function buildTable(frames: SightFrame[], options: Partial<TableOptions> = {}): PieceTable {
  const opt = { ...DEFAULT_TABLE, ...options };
  const stats = { frames: frames.length, used: 0, sure: 0, chained: 0, free: 0, noCenter: 0, blind: 0, clash: 0, dropped: 0, sightings: 0 };
  const ft: number[] = [];
  const kinds: number[] = [];
  const roots: number[] = [];
  const orients: number[] = [];
  const first: number[] = [0];
  const piece: number[] = [];
  const at: number[] = [];

  // 面 fs を、基準の面 root を (face0, r0) に置いたときの置き方（つながらない面は null）。センターが食い違えば null を返す
  const placeAll = (fs: SightFace[], links: number[][], root: number, face0: number, r0: number): (Placed | null)[] | null => {
    const out: (Placed | null)[] = fs.map(() => null);
    out[root] = { face: face0, r: r0 };
    const queue = [root];
    while (queue.length) {
      const a = queue.pop()!;
      const pa = out[a]!;
      for (const [x, y, i, j] of links) {
        if (x !== a && y !== a) continue;
        const b = x === a ? y : x;
        const sa = x === a ? i : j;
        const sb = x === a ? j : i;
        const nb = NEIGHBOR[pa.face * 4 + ((sa - pa.r + 4) & 3)];
        const pb = { face: nb >> 2, r: (sb - (nb & 3) + 4) & 3 };
        const c = fs[b].ids[4];
        if (c >= 0 && fs[b].rot[4] >= 0 && isCenter(c) && Math.floor(c / 9) !== pb.face) return null;
        if (out[b]) {
          if (out[b]!.face !== pb.face || out[b]!.r !== pb.r) return null;
          continue;
        }
        out[b] = pb;
        queue.push(b);
      }
    }
    return out;
  };
  // 置き方 → 読み（ピース, 位置, 欠片か）。同じピースが 2 か所に読めたら、どちらも使わない
  const tmpP: number[] = [];
  const tmpA: number[] = [];
  const read = (fs: SightFace[], placed: (Placed | null)[], count: boolean): void => {
    tmpP.length = tmpA.length = 0;
    for (let i = 0; i < fs.length; i++) {
      const pl = placed[i];
      if (!pl) continue;
      const f = fs[i];
      for (let c = 0; c < 9; c++) {
        const s = f.ids[c];
        if (s < 0 || f.rot[c] < 0) continue;
        const cell = CELL_TURN[pl.r * 9 + c];
        const rot = (f.rot[c] - pl.r + 4) & 3;
        if (isCenter(s)) {
          if (cell !== 4 || Math.floor(s / 9) !== pl.face) {
            if (count) stats.dropped++;
            continue;
          }
          tmpP.push(NUM_PIECES + pl.face);
          tmpA.push(rot);
          continue;
        }
        const p = pl.face * 9 + cell;
        const x = EXPECT_ROT[s * 54 + p] === rot ? REF_AT[s * 54 + p] : -1;
        if (x < 0) {
          if (count) stats.dropped++;
          continue;
        }
        const k = PIECE_OF[s];
        const dup = tmpP.indexOf(k);
        if (dup >= 0) {
          if (tmpA[dup] !== x) tmpA[dup] = 255;
          continue;
        }
        tmpP.push(k);
        tmpA.push(x);
      }
    }
  };

  // 1) フレームごとに、面の接し方・基準の面・ありうる置き方を求める
  interface Prep {
    t: number;
    fs: SightFace[];
    count: number[]; // 面ごとの読めたマスの数
    face0: number; // 基準の面がキューブのどの面か（センターが読めなければ -1）
    root: number;
    options: ((Placed | null)[] | null)[]; // 基準の面の置き方 r（0〜3）ごと。センターがなければ 面 * 4 + r（24 通り）
    valid: number[];
    links: number[][];
  }
  const preps: Prep[] = [];
  for (const fr of frames) {
    const fs = fr.faces.filter((f) => !f.held && f.quad?.length === 8 && f.ids.some((id, c) => id >= 0 && f.rot[c] >= 0));
    if (!fs.length) continue;
    const count = fs.map((f) => f.ids.filter((id, k) => id >= 0 && f.rot[k] >= 0).length);
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
    // 基準の面: センターの読めた面のうち、読めたマスのいちばん多いもの。センターがどれも読めなければ、いちばん読めた面
    let root = -1;
    let any = 0;
    for (let i = 0; i < fs.length; i++) {
      const c = fs[i].ids[4];
      if (count[i] > count[any]) any = i;
      if (c < 0 || fs[i].rot[4] < 0 || !isCenter(c)) continue;
      if (root < 0 || count[i] > count[root]) root = i;
    }
    if (root < 0) {
      if (count[any] < opt.blindCells) {
        stats.noCenter++;
        continue;
      }
      const options: Prep["options"] = [];
      for (let k = 0; k < 24; k++) options.push(placeAll(fs, links, any, k >> 2, k & 3));
      preps.push({ t: fr.t, fs, count, face0: -1, root: any, options, valid: [], links });
      continue;
    }
    const face0 = Math.floor(fs[root].ids[4] / 9);
    const options = [0, 1, 2, 3].map((r) => placeAll(fs, links, root, face0, r));
    const valid = [0, 1, 2, 3].filter((r) => options[r]);
    if (!valid.length) {
      stats.clash++;
      continue;
    }
    preps.push({ t: fr.t, fs, count, face0, root, options, valid, links });
  }
  // 面 i の向き: よく読めた面は自分の格子、欠片は接している面から
  const angleOf = (p: Prep, i: number, r: number) => (p.count[i] >= 4 ? upAngle(p.fs[i].quad, r) : faceUp(p.fs, p.links, i, r));
  // 2) センターが 1 つだけのフレームの向き: 見えている面それぞれの、決まった並びの「上」が画像で向く角度が、近くの「置き方の決まった
  // フレーム」（センター 2 つ）のときから続くもの（読めたマスの数で重み付け）。前向き・後ろ向きにたどり、時間の近い方を選ぶ。
  // 向きの基準は置き方の決まったフレームのものだけ: 1 面だけ見えているときにその面を回すと、面の格子は回る面に付いていく。
  // 続きのフレームで基準を更新すると、回したのを「キューブが回った」と読んでしまう
  const chain = (order: number[]): ({ r: number; gap: number } | null)[] => {
    const angle = new Float64Array(6).fill(Number.NaN);
    const seen = new Float64Array(6).fill(Number.NaN);
    const out: ({ r: number; gap: number } | null)[] = preps.map(() => null);
    for (const f of order) {
      const p = preps[f];
      if (p.face0 < 0) continue;
      if (p.valid.length > 1) {
        let best = -Infinity;
        let r = -1;
        let gap = Infinity;
        for (const c of p.valid) {
          const placed = p.options[c]!;
          let score = 0;
          let used = false;
          let g = Infinity;
          for (let i = 0; i < p.fs.length; i++) {
            const pl = placed[i];
            if (!pl || Number.isNaN(angle[pl.face]) || Math.abs(p.t - seen[pl.face]) > opt.orientMs) continue;
            score += p.count[i] * Math.cos(angleOf(p, i, pl.r) - angle[pl.face]);
            g = Math.min(g, Math.abs(p.t - seen[pl.face]));
            used = true;
          }
          if (used && score > best) {
            best = score;
            r = c;
            gap = g;
          }
        }
        if (r >= 0) out[f] = { r, gap };
        continue;
      }
      const placed = p.options[p.valid[0]]!;
      for (let i = 0; i < p.fs.length; i++) {
        const pl = placed[i];
        if (!pl) continue;
        angle[pl.face] = angleOf(p, i, pl.r);
        seen[pl.face] = p.t;
      }
    }
    return out;
  };
  const idx = preps.map((_, i) => i);
  const fwd = chain(idx);
  const bwd = chain([...idx].reverse());
  // 3) 読みにする（センターのあるフレーム）
  interface Row {
    kind: number;
    p: number[];
    a: number[];
    placed: (Placed | null)[];
  }
  const rows: (Row | null)[] = preps.map(() => null);
  const collect = (fs: SightFace[], placed: (Placed | null)[], count: boolean) => {
    read(fs, placed, count);
    const p: number[] = [];
    const a: number[] = [];
    for (let i = 0; i < tmpP.length; i++) {
      if (tmpA[i] === 255) {
        if (count) stats.dropped++;
        continue;
      }
      p.push(tmpP[i]);
      a.push(tmpA[i]);
    }
    return { p, a };
  };
  for (let pi = 0; pi < preps.length; pi++) {
    const { fs, face0, options: options4, valid } = preps[pi];
    if (face0 < 0) continue;
    let kind = valid.length === 1 ? KIND_SURE : KIND_FREE;
    let r0 = valid[0];
    if (kind !== KIND_SURE) {
      const a = fwd[pi];
      const b = bwd[pi];
      const pick = !a ? b : !b ? a : b.gap < a.gap ? b : a;
      if (pick) {
        r0 = pick.r;
        kind = KIND_CHAINED;
      }
    }
    const placed = options4[r0]!;
    const main = collect(fs, placed, true);
    if (!main.p.length) continue;
    rows[pi] = { kind, ...main, placed };
  }
  // 4) センターが 1 つも読めないフレーム（指がセンターにかかっている）: 24 通りの置き方のうち、前後の近いフレームで見えていたピースの
  // 位置とはっきりいちばん合うもの。合うピースが少ない・紛れるフレームは使わない
  {
    const before: Int16Array[] = [];
    const beforeT: Float64Array[] = [];
    const pos = new Int16Array(NUM_PIECES).fill(-1);
    const posT = new Float64Array(NUM_PIECES).fill(-Infinity);
    for (let pi = 0; pi < preps.length; pi++) {
      before.push(pos.slice());
      beforeT.push(posT.slice());
      const row = rows[pi];
      if (!row) continue;
      for (let i = 0; i < row.p.length; i++)
        if (row.p[i] < NUM_PIECES) {
          pos[row.p[i]] = row.a[i];
          posT[row.p[i]] = preps[pi].t;
        }
    }
    pos.fill(-1);
    posT.fill(Infinity);
    for (let pi = preps.length - 1; pi >= 0; pi--) {
      const row = rows[pi];
      if (row) {
        for (let i = 0; i < row.p.length; i++)
          if (row.p[i] < NUM_PIECES) {
            pos[row.p[i]] = row.a[i];
            posT[row.p[i]] = preps[pi].t;
          }
        continue;
      }
      const p = preps[pi];
      if (p.face0 >= 0) continue;
      let best = 0;
      let second = 0;
      let bestK = -1;
      let bestRead: ReturnType<typeof collect> | null = null;
      for (let k = 0; k < 24; k++) {
        const placed = p.options[k];
        if (!placed) continue;
        const got = collect(p.fs, placed, false);
        let nb = 0;
        let na = 0;
        for (let i = 0; i < got.p.length; i++) {
          const q = got.p[i];
          if (before[pi][q] === got.a[i] && p.t - beforeT[pi][q] <= opt.blindMs) nb++;
          if (pos[q] === got.a[i] && posT[q] - p.t <= opt.blindMs) na++;
        }
        const m = Math.max(nb, na);
        if (m > best) {
          second = best;
          best = m;
          bestK = k;
          bestRead = got;
        } else if (m > second) second = m;
      }
      if (bestRead && best >= opt.blindMatch && best >= second + opt.blindMargin) {
        rows[pi] = { kind: KIND_BLIND, ...bestRead, placed: p.options[bestK]! };
      } else stats.noCenter++;
    }
  }
  // 5) 平らな配列にする
  for (let pi = 0; pi < preps.length; pi++) {
    const row = rows[pi];
    if (!row) continue;
    const { t, fs, face0 } = preps[pi];
    for (let i = 0; i < row.p.length; i++) {
      piece.push(row.p[i]);
      at.push(row.a[i]);
    }
    // 認識のスロットと合う姿勢
    let o = -1;
    for (let c = 0; c < 24 && o < 0; c++) {
      let ok = true;
      for (let i = 0; i < fs.length && ok; i++) {
        const pl = row.placed[i];
        if (pl && (VIEW[c * 54 + fs[i].slot * 9 + 1] !== pl.face * 9 + CELL_TURN[pl.r * 9 + 1] || VIEW[c * 54 + fs[i].slot * 9 + 4] !== pl.face * 9 + 4)) ok = false;
      }
      if (ok) o = c;
    }
    ft.push(t);
    kinds.push(row.kind);
    roots.push(Math.max(0, face0));
    orients.push(o);
    first.push(piece.length);
    if (row.kind === KIND_SURE) stats.sure++;
    else if (row.kind === KIND_BLIND) stats.blind++;
    else if (row.kind === KIND_CHAINED) stats.chained++;
    else stats.free++;
  }
  const n = ft.length;
  const total = piece.length;
  // 同じピースが同じ所に続けて見えた読み（連なり）の長さ: 2 枚以上のものだけ使う。センターの向きは centerMinRun 枚以上
  const lists: number[][] = Array.from({ length: NUM_PIECES + 6 }, () => []);
  for (let j = 0; j < total; j++) lists[piece[j]].push(j);
  const solid = new Uint8Array(total);
  for (let p = 0; p < lists.length; p++) {
    const L = lists[p];
    for (let a = 0; a < L.length; ) {
      let b = a;
      while (b < L.length && at[L[b]] === at[L[a]]) b++;
      if (b - a >= (p < NUM_PIECES ? 2 : Math.max(2, opt.centerMinRun))) for (let i = a; i < b; i++) solid[L[i]] = 1;
      a = b;
    }
  }
  stats.used = n;
  stats.sightings = total;
  return { n, t: Float64Array.from(ft), kind: Uint8Array.from(kinds), root: Int8Array.from(roots), orient: Int8Array.from(orients), first: Int32Array.from(first), piece: Uint8Array.from(piece), at: Uint8Array.from(at), solid, stats };
}

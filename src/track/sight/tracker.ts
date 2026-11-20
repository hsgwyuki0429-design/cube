// 新しい追跡器（ライブと精密解析で同じもの）: フレームの読みを観測にまとめずにそのまま入れる。
//   仮説 = ピースの状態（20 個のピースの代表のステッカーのある facelet: src/track/pieces/model.ts）+ 姿勢（キューブ固定 → カメラ、24 通り）
//   フレームごとに、各仮説がそのフレームの読みとどれだけ合わないか（読みの種類ごとの誤読の率から決めたコスト）を足していく。
//   合わない仮説からだけ手を探して子を作る（読んだステッカーの位置までの距離の表 DIST で、届かない枝に入らない）。
//   同じ状態・姿勢の仮説はコストの小さい方だけ残す（ビタビ）。上位 beam だけ残す。
// 観測器（2 枚続いたら観測）・作り変え・手順の知識は使わない。1 枚だけの誤読は「次のフレームで元に戻る」ので手を足した仮説が
// 損をし、本当の手は「その後も続く」ので元の仮説が損をする。同じマスに同じ読みが続くときは、2 枚目からコストを runFactor 倍にする
// （読み違いも続くので、続いた枚数だけ重ねない）。
// DOM もカメラも知らない
import { type CubeState, NUM_MOVES, VIEW, redundantAfter } from "../../cube/model";
import { mostLikelyState } from "../../cube/pattern";
import { PARTNERS } from "../../cube/stickers";
import { type RecoverOptions, orientsOf, recoverFrom } from "../recover";
import type { Observation } from "../types";
import { DIST, NEAR, NUM_PIECES, PERM, PIECE_OF, REF_AT, fromCubeState, toCubeState } from "../pieces/model";

export interface SightOptions {
  beam: number; // 残す仮説の数
  expand: number; // 手を探す仮説の数（コストの小さい方から。そのフレームの読みと合わないものだけ）
  depth: number; // その仮説から探す手数
  deepHyps: number; // さらに深く探す仮説の数
  deepDepth: number;
  children: number; // 1 つの仮説から作る子の数の上限
  moveCost: number; // 1 手のコスト
  rotNear: number; // 持ち替え（カメラの軸のまわりに 90°）のコスト
  rotFar: number; // それ以外の姿勢の変わり方のコスト
  centerCost: number; // センターの読みと姿勢が合わないコスト
  clsCost: number[]; // 読みの種類ごとの、合わないときのコスト（直接・面 / 直接・欠片 / 引き継ぎ・面 / 引き継ぎ・欠片）
  runFactor: number; // 前のフレームにも同じマスに同じ読みがあったときの倍率
  directW: number; // 認識の重みがこれ以上を直接読んだとみなす
  bigFace: number; // 直接読んだマスがこれ以上の面は「面」
  // 1 つの面の読みのコストの上限。面の割り当て（スロット）が 1 枚だけ狂ったフレーム（上の面を正面と読んだ）は、どの状態でも
  // 説明がつかない。上限がないと、手を足した仮説がそのフレームだけ得をして残った。本当の変化は次のフレームにも続くので、
  // 上限を払い続けた仮説が負ける
  faceCap: number;
  // 見失ったところから戻る（src/track/recover.ts）: 最後に読みとよく合っていた仮説（錨: 直接読んだステッカー anchorReads 以上が全部合う）から、
  // recoverMs の間、合わないフレームで読めたステッカーが全部合う手順を探して仮説に足す
  recover: boolean;
  anchorReads: number;
  recoverMs: number;
  recoverGapMs: number;
  recoverOpt: Partial<RecoverOptions>;
  // 作り変え: 一番の仮説でも合わない（面の上限を払う）フレームが snapAfter 枚続いたら、読みに合う物理的にありえる状態（見えていない
  // マスはその仮説のまま: mostLikelyState）を仮説に足す。コスト snapCost の上乗せ（手 3 手分ほど）。後のフレームも合えば残る。
  // 手順は作り変えの前後でつながらない（tail を切る。base に作り変えた状態）
  snap: boolean;
  snapAfter: number;
  snapCost: number;
  snapMinReads: number;
  viewCost: number; // 表示だけ作り変える、一番の仮説のフレームのコスト
}

// 読みの種類ごとの誤読の率（実物の T-perm 2 本、姿勢を正解に合わせたとき: tests/debug/sightPlace.debug.test.ts）から、
// コスト = ln((1 − e) / e)。e = 0.4%・5%・3%・6%
const cost = (e: number) => Math.log((1 - e) / e);
export const DEFAULT_SIGHT: SightOptions = {
  beam: 48,
  expand: 8,
  depth: 2,
  deepHyps: 3,
  deepDepth: 4,
  children: 24,
  moveCost: 2.5,
  rotNear: 3,
  rotFar: 6,
  centerCost: 6,
  clsCost: [cost(0.004), cost(0.05), cost(0.03), cost(0.06)],
  runFactor: 0.35,
  directW: 0.85,
  bigFace: 4,
  faceCap: 6,
  recover: true,
  anchorReads: 8,
  recoverMs: 2500,
  recoverGapMs: 100,
  recoverOpt: {},
  snap: true,
  snapAfter: 2,
  snapCost: 8,
  snapMinReads: 4,
  viewCost: 5,
};

export interface SightInput {
  t: number;
  faces: { slot: number; ids?: number[]; w?: number[]; weight?: number[]; rot?: number[]; held?: boolean }[];
}

export interface MoveNode {
  move: number;
  t0: number; // 前のフレームの時刻（この手はこの後に回し始めた）
  t: number; // この手の後の状態が最初に見えたフレーム
  orient: number;
  prev: MoveNode | null;
  inferred?: boolean;
}

export interface SightHyp {
  pos: Uint8Array;
  o: number;
  cost: number;
  tail: MoveNode | null;
  last: number; // 最後の手（同じ面の手を続けない）
  frameCost: number; // 最後のフレームのコスト
  base?: { state: CubeState; t: number; n: number }; // 作り変えた状態（tail はこの状態からの手）
}

interface Read {
  q: number; // カメラフレームの facelet（スロット * 9 + マス）
  s: number; // 読んだステッカー
  piece: number;
  w: number;
  face: number; // 読みの面の番号（0〜）
  direct: boolean;
}

export const hashOf = (pos: Uint8Array, o: number): number => {
  let h = 2166136261 ^ o;
  for (let i = 0; i < pos.length; i++) h = Math.imul(h ^ pos[i], 16777619);
  return h >>> 0;
};

export function movesOf(tail: MoveNode | null): MoveNode[] {
  const out: MoveNode[] = [];
  for (let n = tail; n; n = n.prev) out.push(n);
  return out.reverse();
}

export class SightTracker {
  options: SightOptions;
  hyps: SightHyp[];
  frames = 0;
  lastT = -Infinity;
  offset = 0; // 仮説のコストから引いた分の合計（コスト + offset = はじめからの合計）
  expanded = 0; // 最後のフレームで評価した子の数（調べる用）
  private prevReads = new Set<number>();
  private reads: Read[] = [];
  private centers: { slot: number; f: number; face: number }[] = [];
  private nFaces = 0;
  private faceSum = new Float64Array(8);
  private need = new Int16Array(64);
  private anchor: SightHyp | null = null;
  private anchorT = -Infinity;
  private lastRecoverT = -Infinity;
  recoveries = 0;
  snaps = 0;
  // 表示用の作り変え（ライブ）: 一番の仮説でも合わない（面の上限を払う）フレームでは、見えている読みに合う状態を出す（null = 一番の仮説）
  view: { state: CubeState; o: number } | null = null;
  private badRun = 0;

  constructor(start: CubeState, options: Partial<SightOptions> = {}, orients?: number[]) {
    this.options = { ...DEFAULT_SIGHT, ...options };
    const pos = fromCubeState(start).pos;
    this.hyps = (orients ?? Array.from({ length: 24 }, (_, o) => o)).map((o) => ({ pos: pos.slice(), o, cost: 0, tail: null, last: -1, frameCost: 0 }));
  }

  best(): SightHyp {
    return this.hyps[0];
  }

  state(h = this.best()): CubeState {
    return toCubeState(h.pos);
  }

  // 読みを作る
  private load(input: SightInput): void {
    const opt = this.options;
    const reads: Read[] = [];
    const centers: { slot: number; f: number; face: number }[] = [];
    let face = 0;
    const cur = new Set<number>();
    const where = new Map<number, number>();
    const dup = new Set<number>();
    for (const f of input.faces) {
      if (!f.ids) continue;
      const w = f.w ?? f.weight;
      const direct = f.ids.map((id, c) => id >= 0 && (w?.[c] ?? 1) >= opt.directW && (f.rot ? f.rot[c] >= 0 : true));
      const big = direct.filter(Boolean).length >= opt.bigFace;
      const fi = face++;
      for (let c = 0; c < 9; c++) {
        const s = f.ids[c];
        if (s < 0) continue;
        if (s % 9 === 4) {
          if (c === 4 && direct[c]) centers.push({ slot: f.slot, f: s, face: fi });
          continue;
        }
        const piece = PIECE_OF[s];
        if (piece < 0 || c === 4) continue;
        const q = f.slot * 9 + c;
        const key = q * 54 + s;
        cur.add(key);
        const cls = direct[c] ? (big ? 0 : 1) : big ? 2 : 3;
        if (where.has(s)) {
          dup.add(s);
          continue;
        }
        where.set(s, reads.length);
        reads.push({ q, s, piece, face: fi, direct: direct[c], w: opt.clsCost[cls] * (this.prevReads.has(key) ? opt.runFactor : 1) });
      }
    }
    this.reads = dup.size ? reads.filter((r) => !dup.has(r.s)) : reads;
    this.centers = centers;
    this.prevReads = cur;
    this.nFaces = face;
    if (this.faceSum.length < face) this.faceSum = new Float64Array(face * 2);
  }

  // 姿勢 o の読みの、ピースが要る位置（need）を求める
  private needs(o: number): void {
    const rs = this.reads;
    if (this.need.length < rs.length) this.need = new Int16Array(rs.length * 2);
    for (let i = 0; i < rs.length; i++) this.need[i] = REF_AT[rs[i].s * 54 + VIEW[o * 54 + rs[i].q]];
  }

  // 姿勢 o（needs(o) を先に呼ぶ）・状態 pos のフレームのコスト（面ごとに上限）
  private frameCost(pos: Uint8Array, o: number): number {
    const rs = this.reads;
    const need = this.need;
    const sum = this.faceSum;
    sum.fill(0, 0, this.nFaces);
    for (let i = 0; i < rs.length; i++) if (pos[rs[i].piece] !== need[i]) sum[rs[i].face] += rs[i].w;
    for (const x of this.centers) if (VIEW[o * 54 + x.slot * 9 + 4] !== x.f) sum[x.face] += this.options.centerCost;
    let c = 0;
    const cap = this.options.faceCap;
    for (let f = 0; f < this.nFaces; f++) c += sum[f] < cap ? sum[f] : cap;
    return c;
  }

  // 残り rem 手では、どうやっても合わない読みのコストの和（下限）
  private bound(pos: Uint8Array, rem: number, o: number): number {
    const rs = this.reads;
    const need = this.need;
    const sum = this.faceSum;
    sum.fill(0, 0, this.nFaces);
    for (let i = 0; i < rs.length; i++) if (DIST[pos[rs[i].piece] * 54 + need[i]] > rem) sum[rs[i].face] += rs[i].w;
    for (const x of this.centers) if (VIEW[o * 54 + x.slot * 9 + 4] !== x.f) sum[x.face] += this.options.centerCost;
    let c = 0;
    const cap = this.options.faceCap;
    for (let f = 0; f < this.nFaces; f++) c += sum[f] < cap ? sum[f] : cap;
    return c;
  }

  push(input: SightInput): SightHyp {
    const opt = this.options;
    this.load(input);
    const t = input.t;
    const t0 = Number.isFinite(this.lastT) ? this.lastT : t;
    this.lastT = t;
    this.frames++;
    this.expanded = 0;
    if (!this.reads.length && !this.centers.length) return this.hyps[0];
    const pool = new Map<number, SightHyp>();
    const add = (h: SightHyp) => {
      const k = hashOf(h.pos, h.o);
      const old = pool.get(k);
      if (!old || old.cost > h.cost) pool.set(k, h);
    };
    // 1) 手を足さない: 姿勢はそのまま、または持ち替え
    const base: SightHyp[] = [];
    const rotCost = new Map<SightHyp, number>(); // 持ち替えた仮説の、持ち替えのコスト
    for (const h of this.hyps) {
      this.needs(h.o);
      const c0 = this.frameCost(h.pos, h.o);
      const stay: SightHyp = { ...h, cost: h.cost + c0, frameCost: c0 };
      base.push(stay);
      add(stay);
      if (c0 > 0) {
        for (let o = 0; o < 24; o++) {
          if (o === h.o) continue;
          const rc = NEAR[h.o * 24 + o] ? opt.rotNear : opt.rotFar;
          if (rc >= c0) continue;
          this.needs(o);
          const c1 = rc + this.frameCost(h.pos, o);
          if (c1 < c0) {
            const r: SightHyp = { ...h, o, cost: h.cost + c1, frameCost: c1 };
            rotCost.set(r, rc);
            base.push(r);
            add(r);
          }
        }
      }
    }
    // 2) 合わない仮説から手を探す（コストの小さい方から）
    base.sort((a, b) => a.cost - b.cost);
    let tried = 0;
    const seen = new Set<number>();
    for (const h of base) {
      if (tried >= opt.expand) break;
      if (h.frameCost <= 0) continue;
      const k = hashOf(h.pos, h.o);
      if (seen.has(k)) continue;
      seen.add(k);
      const depth = tried < opt.deepHyps ? opt.deepDepth : opt.depth;
      tried++;
      this.needs(h.o);
      const rc = rotCost.get(h) ?? 0;
      const limit = h.frameCost - rc; // 手を足した子は、手を足さないより安いものだけ
      const found: { seq: number[]; cost: number }[] = [];
      const stack: Uint8Array[] = Array.from({ length: depth + 1 }, () => new Uint8Array(NUM_PIECES));
      stack[0].set(h.pos);
      const seq: number[] = [];
      const dfs = (d: number, last: number) => {
        if (d === depth) return;
        const cur = stack[d];
        const nxt = stack[d + 1];
        for (let m = 0; m < NUM_MOVES; m++) {
          if (redundantAfter(last, m)) continue;
          for (let i = 0; i < NUM_PIECES; i++) nxt[i] = PERM[m][cur[i]];
          this.expanded++;
          const g = (d + 1) * opt.moveCost;
          if (g >= limit) continue;
          const rem = depth - d - 1;
          if (g + this.bound(nxt, rem, h.o) >= limit) continue;
          seq.push(m);
          const c = this.frameCost(nxt, h.o);
          if (g + c < limit) found.push({ seq: seq.slice(), cost: g + c });
          if (rem > 0) dfs(d + 1, m);
          seq.pop();
        }
      };
      dfs(0, -1); // フレームをまたいだ同じ面の手は別の手（U の後に時間をおいて U）
      found.sort((a, b) => a.cost - b.cost);
      for (const f of found.slice(0, opt.children)) {
        const pos = h.pos.slice();
        let tail = h.tail;
        for (const m of f.seq) {
          for (let i = 0; i < NUM_PIECES; i++) pos[i] = PERM[m][pos[i]];
          tail = { move: m, t0, t, orient: h.o, prev: tail };
        }
        const fc = f.cost + rc;
        add({ pos, o: h.o, cost: h.cost - h.frameCost + fc, tail, last: f.seq[f.seq.length - 1], frameCost: fc, base: h.base });
      }
    }
    let next = [...pool.values()].sort((a, b) => a.cost - b.cost).slice(0, opt.beam);
    // 3) 錨を覚える・見失ったら錨から探す
    const strong = this.reads.filter((r) => r.direct).length;
    this.badRun = next[0].frameCost >= opt.faceCap ? this.badRun + 1 : 0;
    if (next[0].frameCost === 0) this.view = null;
    else if (next[0].frameCost >= opt.viewCost && this.reads.length >= opt.snapMinReads) {
      const sn = this.snapState(next[0]);
      if (sn) this.view = { state: sn.state, o: next[0].o };
    }
    if (opt.snap && this.badRun >= opt.snapAfter && this.reads.length >= opt.snapMinReads) {
      const sn = this.snapFrom(next[0], t);
      if (sn) {
        pool.set(hashOf(sn.pos, sn.o), sn);
        next = [...pool.values()].sort((a, b) => a.cost - b.cost).slice(0, opt.beam);
      }
    }
    if (next[0].frameCost === 0 && strong >= opt.anchorReads) {
      this.anchor = next[0];
      this.anchorT = t;
    } else if (opt.recover && this.anchor && next[0].frameCost >= opt.faceCap && t - this.anchorT <= opt.recoverMs && t - this.lastRecoverT >= opt.recoverGapMs) {
      this.lastRecoverT = t;
      const got = this.recoverNow(t, t0, next[0].cost);
      if (got.length) {
        for (const h of got) pool.set(hashOf(h.pos, h.o), h);
        next = [...pool.values()].sort((a, b) => a.cost - b.cost).slice(0, opt.beam);
      }
    }
    const c0 = next[0].cost;
    this.offset += c0;
    for (const h of next) h.cost -= c0;
    this.hyps = next;
    return next[0];
  }

  // 読みに合う物理的にありえる状態（姿勢は h のまま。見えていないマスは h の状態をなるべく保つ）
  private snapFrom(h: SightHyp, t: number): SightHyp | null {
    const sn = this.snapState(h);
    if (!sn) return null;
    this.snaps++;
    return { pos: sn.pos, o: h.o, cost: h.cost - h.frameCost + sn.fc + this.options.snapCost, tail: null, last: -1, frameCost: sn.fc, base: { state: sn.state, t, n: this.snaps } };
  }

  private snapState(h: SightHyp): { state: CubeState; pos: Uint8Array; fc: number } | null {
    const prior = toCubeState(h.pos);
    const want = new Map<number, { color: number; w: number }>();
    for (const r of this.reads) {
      const f = VIEW[h.o * 54 + r.q];
      if (PARTNERS[f].length !== PARTNERS[r.s].length) continue;
      const put = (g: number, color: number, w: number) => {
        const old = want.get(g);
        if (!old || old.w < w) want.set(g, { color, w });
      };
      put(f, Math.floor(r.s / 9), r.w);
      PARTNERS[f].forEach((g, k) => put(g, Math.floor(PARTNERS[r.s][k] / 9), r.w * 0.8));
    }
    const { state } = mostLikelyState((f, color) => {
      const x = want.get(f);
      if (x) return x.color === color ? 0 : x.w;
      return color === prior[f] ? 0 : 0.3;
    });
    const pos = fromCubeState(state).pos;
    this.needs(h.o);
    const fc = this.frameCost(pos, h.o);
    if (fc >= h.frameCost) return null;
    return { state, pos, fc };
  }

  private recoverNow(t: number, t0: number, bestCost: number): SightHyp[] {
    const a = this.anchor!;
    // 読みを観測の形にする（recover.ts は ids と idCost だけを使う。直接読んだマスだけ）
    const bySlot = new Map<number, { ids: Int16Array; idCost: Float32Array }>();
    const face = (slot: number) => {
      let f = bySlot.get(slot);
      if (!f) bySlot.set(slot, (f = { ids: new Int16Array(9).fill(-1), idCost: new Float32Array(9) }));
      return f;
    };
    for (const r of this.reads)
      if (r.direct) {
        const f = face(Math.floor(r.q / 9));
        f.ids[r.q % 9] = r.s;
        f.idCost[r.q % 9] = 1;
      }
    for (const c of this.centers) {
      const f = face(c.slot);
      f.ids[4] = c.f;
      f.idCost[4] = 1;
    }
    const obs = { t, tPrevEnd: t0, faces: [...bySlot].map(([slot, f]) => ({ slot, ...f, cost: new Float32Array(54), labels: new Int8Array(9).fill(-1) })) } as Observation;
    const orients = orientsOf(obs, [a.o, ...Array.from({ length: 24 }, (_, o) => o).filter((o) => NEAR[a.o * 24 + o])]);
    const got = recoverFrom(toCubeState(a.pos), obs, orients, this.options.recoverOpt);
    if (!got?.length) return [];
    this.recoveries++;
    return got.map((g) => {
      let tail = a.tail;
      const n = g.seq.length;
      g.seq.forEach((m, i) => {
        const tm = this.anchorT + ((t - this.anchorT) * (i + 1)) / (n + 1);
        tail = { move: m, t0: tm, t: tm, orient: g.orient, prev: tail, inferred: true };
      });
      return { pos: fromCubeState(g.state).pos, o: g.orient, cost: bestCost - 0.5, tail, last: g.seq[n - 1], frameCost: 0, base: a.base };
    });
  }

  // 終わりの状態が分かっているとき（精密解析）: その状態の仮説のうち一番安いもの。なければ一番安い仮説から 3 手まで足して届くもの
  finish(target: CubeState): { hyp: SightHyp; added: number } | null {
    const goal = fromCubeState(target).pos;
    const eq = (a: Uint8Array) => a.every((x, i) => x === goal[i]);
    const hit = this.hyps.find((h) => eq(h.pos));
    if (hit) return { hyp: hit, added: 0 };
    for (const h of this.hyps.slice(0, 8)) {
      const found = this.reach(h.pos, goal, 3, h.last);
      if (found) {
        const pos = h.pos.slice();
        let tail = h.tail;
        for (const m of found) {
          for (let i = 0; i < NUM_PIECES; i++) pos[i] = PERM[m][pos[i]];
          tail = { move: m, t0: this.lastT, t: this.lastT, orient: h.o, prev: tail, inferred: true };
        }
        return { hyp: { ...h, pos, tail }, added: found.length };
      }
    }
    return null;
  }

  private reach(from: Uint8Array, goal: Uint8Array, max: number, last: number): number[] | null {
    for (let d = 1; d <= max; d++) {
      const seq: number[] = [];
      const go = (p: Uint8Array, rem: number, l: number): boolean => {
        if (rem === 0) return p.every((x, i) => x === goal[i]);
        for (let i = 0; i < NUM_PIECES; i++) if (DIST[p[i] * 54 + goal[i]] > rem) return false;
        for (let m = 0; m < NUM_MOVES; m++) {
          if (redundantAfter(l, m)) continue;
          const q = Uint8Array.from(p, (x) => PERM[m][x]);
          seq.push(m);
          if (go(q, rem - 1, m)) return true;
          seq.pop();
        }
        return false;
      };
      if (go(from, d, last)) return seq;
    }
    return null;
  }
}

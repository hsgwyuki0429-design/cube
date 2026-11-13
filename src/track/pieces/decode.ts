// ピースの時刻表（table.ts）から手順を解く。
//   1) 観測にまとめる: 同じピースが違う所に見えるまでのフレームを 1 つの「見え方」（どのピースがどこに・何枚見えたか）にする
//   2) 見え方から次の見え方へ、0〜数手の手順を深さ優先で漏れなく試す。状態 = ピース 20 個の位置（1 手 = 表を 20 回引く）。
//      コスト = 手の数 + 見え方と合わないピースの重み。「このピースを合わせるには最低あと何手要るか」（DIST）から、残りの深さで
//      どうしても合わないピースの重みが分かるので、候補より悪くなると分かった枝には入らない。同じ状態は安い方だけ残す
//   3) 始まりから前向き・終わりから後ろ向きの両方で解き、同じ見え方で同じ状態になった所を、合計コストの小さい所でつなぐ
// 認識のスロット・姿勢は使わない（表がキューブ固定の位置になっている）ので、仮説に姿勢がなく、持ち替えを探す枝もない。
// DOM もカメラも知らない
import { type CubeState, OPPOSITE, inverseMove } from "../../cube/model";
import { DIST, NUM_PIECES, PERM, WHOLE, fromCubeState } from "./model";
import { KIND_CHAINED, KIND_FREE, type PieceTable } from "./table";

export interface DecodeOptions {
  beam: number; // 見え方ごとに残す仮説の数
  margin: number; // 一番よい仮説よりこれ以上悪い候補は捨てる
  maxMoves: number; // 見え方から次の見え方までに入れる手の上限
  minMoves: number; // 見え方の間が短くても、ここまでは入れる
  msPerMove: number; // 見え方の間がこれだけ開くごとに、入れてよい手を 1 つ増やす
  payback: number; // 手を入れた仮説は、入れないときよりこれ以上は悪くならないこと（読めたピースが少ない見え方のために 1 手ぶんは許す）
  frameWeight: number; // 1 枚ぶんの重み
  cellCap: number; // 1 つの見え方の 1 ピースの重みの上限
  centerWeight: number; // センターの向き（その面を回した回数）が合わないときの重み
  splitMs: number; // フレームの間がこれより開いたら、見え方を分ける（手の時刻のため）
  endWeight: number; // 終わりの状態と違うピース 1 個のコスト
  endMoves: number; // 最後の見え方から終わりまでに足してよい手
  keep: number; // つなぐために、見え方ごとに覚えておく仮説の数
  afterMeet: number; // 後ろ向きは、前向きとつながってからこれだけ見え方を進めたらやめる
  // センターが 1 つだけのフレームだけでできた見え方は、その面のまわりの 4 通りの置き方のどれでもよい。表が選んだもの（向きの続くもの）と
  // 違う置き方のコスト（1 手より高く: 1 面だけ見えていてその面を回したのと区別できないときは、手とみる。2 手より安く）
  twistCost: number;
  minPieces: number; // これより少ないピースしか見えなかった見え方は使わない（合わせる短い手順がいくらでもあり、本当の手順を落とす）
  deepHyps: number; // 4 手以上の手順を試すのは、コストの小さい方からこれだけの仮説
  // 空白を越える探索: ふつうの探索で、いちばんよい仮説でもこの見え方と stuck 以上食い違い、見えたピースが bridgePieces 個以上あるとき、
  // 上位 bridgeHyps 個の仮説から、見えたピースが全部合う手順を bridgeMoves 手まで探す（前から半分・後ろから半分を突き合わせる）
  stuck: number;
  bridgePieces: number;
  bridgeHyps: number;
  bridgeMoves: number;
  // 見失った: いちばんよい仮説の食い違い（コスト − 手の数）が、直近 lostSteps 個の見え方で lostCost 以上増えたら、その向きの探索をやめる
  lostSteps: number;
  lostCost: number;
  nodeCap: number; // 1 つの見え方で試す候補の上限（見失った仮説が探索を膨らませないように）
  onStep?: (info: { back: boolean; step: number; t: number; pieces: number; depth: number; hyps: number; best: number; expanded: number; moves: number[] }) => void; // 調査用
}

export const DEFAULT_DECODE: DecodeOptions = { beam: 96, margin: 4, maxMoves: 5, minMoves: 3, msPerMove: 150, payback: 1, frameWeight: 0.5, cellCap: 1.5, centerWeight: 0.5, splitMs: 100, endWeight: 10, endMoves: 4, keep: 64, afterMeet: 3, twistCost: 1.3, minPieces: 4, deepHyps: 4, lostSteps: 4, lostCost: 14, stuck: 2, bridgePieces: 5, bridgeHyps: 4, bridgeMoves: 8, nodeCap: 400000 };

// 見え方: 見えたピース（センターは 20 + 面、位置は回した回数）と重み
export interface Sight {
  t0: number; // 最初のフレーム
  t1: number; // 最後のフレーム
  frame0: number;
  frame1: number;
  piece: Uint8Array;
  at: Uint8Array;
  w: Float32Array;
  root: number; // センターが 1 つだけのフレームだけでできた見え方: その面（ほかの置き方はこの面のまわり）。そうでなければ -1
  alt?: Uint8Array[]; // ほかの置き方（1〜3）でのピースの位置
}

export function buildSights(tb: PieceTable, options: Partial<DecodeOptions> = {}): Sight[] {
  const opt = { ...DEFAULT_DECODE, ...options };
  const out: Sight[] = [];
  const snap = new Int16Array(NUM_PIECES + 6).fill(-1);
  const cnt = new Uint16Array(NUM_PIECES + 6);
  let f0 = -1;
  let f1 = -1;
  let root = -2; // -2 = まだ、-1 = 置き方の決まったフレームがある
  const close = () => {
    if (f0 < 0) return;
    const ps: number[] = [];
    for (let p = 0; p < snap.length; p++) if (snap[p] >= 0) ps.push(p);
    if (ps.filter((p) => p < NUM_PIECES).length >= opt.minPieces) {
      const at = Uint8Array.from(ps, (p) => snap[p]);
      out.push({
        root: root < 0 ? -1 : root,
        ...(root >= 0 ? { alt: [1, 2, 3].map((d) => Uint8Array.from(ps, (p, i) => (p < NUM_PIECES ? WHOLE[(root * 4 + d) * 54 + at[i]] : at[i]))) } : {}),
        t0: tb.t[f0],
        t1: tb.t[f1],
        frame0: f0,
        frame1: f1,
        piece: Uint8Array.from(ps),
        at,
        w: Float32Array.from(ps, (p) => (p < NUM_PIECES ? Math.min(opt.cellCap, opt.frameWeight * cnt[p]) : opt.centerWeight)),
      });
    }
    root = -2;
    snap.fill(-1);
    cnt.fill(0);
    f0 = -1;
  };
  for (let f = 0; f < tb.n; f++) {
    if (tb.kind[f] === KIND_FREE) continue;
    let conflict = false;
    for (let j = tb.first[f]; j < tb.first[f + 1] && !conflict; j++) if (tb.solid[j] && snap[tb.piece[j]] >= 0 && snap[tb.piece[j]] !== tb.at[j]) conflict = true;
    if (conflict || (f1 >= 0 && f0 >= 0 && tb.t[f] - tb.t[f1] > opt.splitMs)) close();
    let any = false;
    for (let j = tb.first[f]; j < tb.first[f + 1]; j++) {
      if (!tb.solid[j]) continue;
      snap[tb.piece[j]] = tb.at[j];
      cnt[tb.piece[j]]++;
      any = true;
    }
    if (!any) continue;
    const r = tb.kind[f] === KIND_CHAINED ? tb.root[f] : -1;
    root = root === -2 ? r : root === r ? r : -1;
    if (f0 < 0) f0 = f;
    f1 = f;
  }
  close();
  return out;
}

export interface DecodedPieceMove {
  move: number;
  sight: number; // この手の後の見え方の番号（終わりに足した手は sights.length）
  t0: number; // 前の見え方が最後に見えた時刻
  t: number; // 次の見え方が最初に見えた時刻
  inferred?: boolean;
}

export interface DecodeResult {
  moves: DecodedPieceMove[];
  reachedEnd: boolean;
  method: "meet" | "forward" | "backward" | "none";
  cost: number;
  sights: number;
  expanded: number;
  ms: number;
}

const SIZE = 32;
const TURNS = 20;
const OFF = 26;

interface Hyp {
  s: Uint8Array;
  cost: number;
  path: number;
}

interface Pass {
  sets: Map<number, { cost: number; path: number }>[]; // 見え方ごとの仮説（位置のハッシュ → コスト・手の木の節点）
  final: Hyp | null; // 終わりの状態にたどり着いた仮説
  moves: (path: number) => { move: number; sight: number }[];
  expanded: number;
}

// 状態（最初の len バイト）のハッシュ（53 ビットに収まる数）。同じ見え方に残る仮説は数千までなので、衝突は考えなくてよい
function hashOf(s: Uint8Array, len: number): number {
  let a = 0x811c9dc5;
  let b = 0x1b873593;
  for (let i = 0; i < len; i++) {
    a = Math.imul(a ^ s[i], 0x01000193);
    b = Math.imul(b + s[i], 0x85ebca6b) ^ (b >>> 13);
  }
  return (a >>> 0) * 0x200000 + ((b >>> 0) & 0x1fffff);
}

// stop: 見え方 step を処理した後に呼ぶ。true を返したらやめる（後ろ向き: 前向きとつながった）
function pass(sights: Sight[], start: Uint8Array, end: Uint8Array | null, opt: DecodeOptions, stop?: (step: number, set: Map<number, { cost: number; path: number }>) => boolean): Pass {
  let pathParent = new Int32Array(4096);
  let pathInfo = new Int32Array(4096);
  let paths = 0;
  const addPath = (parent: number, move: number, sight: number) => {
    if (paths === pathParent.length) {
      const a = new Int32Array(paths * 2);
      a.set(pathParent);
      pathParent = a;
      const b = new Int32Array(paths * 2);
      b.set(pathInfo);
      pathInfo = b;
    }
    pathParent[paths] = parent;
    pathInfo[paths] = move + sight * 32;
    return paths++;
  };
  const s0 = new Uint8Array(SIZE);
  s0.set(start);
  s0.fill(4, OFF);
  let cur: Hyp[] = [{ s: s0, cost: 0, path: -1 }];
  const sets: Pass["sets"] = [];
  let expanded = 0;
  const steps = end ? sights.length + 1 : sights.length;
  // 見え方（か終わりの状態）: ピース・位置・重み
  let P: Uint8Array = new Uint8Array(0);
  let A: Uint8Array = new Uint8Array(0);
  let W: Float32Array = new Float32Array(0);
  let nP = 0; // ピース（センター以外）の数。P はピースが先、センターが後
  const endP = Uint8Array.from({ length: NUM_PIECES }, (_, k) => k);
  const endW = new Float32Array(NUM_PIECES).fill(opt.endWeight);
  // 食い違いのコスト（センターは、基準が決まっているものだけ）
  let ALT: Uint8Array[] | null = null; // ほかの置き方（センターが 1 つだけの見え方）
  const mismatch = (s: Uint8Array): number => {
    let c = 0;
    for (let i = 0; i < nP; i++) if (s[P[i]] !== A[i]) c += W[i];
    for (let i = nP; i < P.length; i++) {
      const x = P[i] - NUM_PIECES;
      if (s[OFF + x] !== 4 && ((s[TURNS + x] + s[OFF + x]) & 3) !== A[i]) c += W[i];
    }
    if (ALT && c > opt.twistCost)
      for (const B of ALT) {
        let e = opt.twistCost;
        for (let i = 0; i < nP && e < c; i++) if (s[P[i]] !== B[i]) e += W[i];
        if (e < c) c = e;
      }
    return c;
  };
  // あと r 手ではどうしても合わないピース（合わせるのに DIST 手要る）の重み
  const unreach = (s: Uint8Array, r: number): number => {
    let c = 0;
    for (let i = 0; i < nP; i++) if (DIST[s[P[i]] * 54 + A[i]] > r) c += W[i];
    if (ALT && c > opt.twistCost)
      for (const B of ALT) {
        let e = opt.twistCost;
        for (let i = 0; i < nP && e < c; i++) if (DIST[s[P[i]] * 54 + B[i]] > r) e += W[i];
        if (e < c) c = e;
      }
    return c;
  };
  let pool = new Map<number, Hyp>();
  let best = Infinity;
  let mine = Infinity; // いま展開している仮説の、いちばんよい子（手を入れないものも含む）のコスト
  let step = 0;
  const stack = new Uint8Array(16);
  const bufs = Array.from({ length: 8 }, () => new Uint8Array(SIZE));
  // 残すコストの上限: 全体のいちばんから margin まで、かつ、その仮説のいちばんよい子から payback まで
  // （手は、その分だけ食い違いを減らすこと。読めたピースの少ない見え方のために 1 手ぶんは許す）
  const offer = (s: Uint8Array, base: number, depth: number, parent: number): void => {
    expanded++;
    const c = base + mismatch(s);
    if (c > best + opt.margin || c > mine + opt.payback) return;
    if (c < mine) mine = c;
    const key = hashOf(s, SIZE);
    const old = pool.get(key);
    if (old && old.cost <= c) return;
    const leaf = s.slice();
    // センターの基準が決まっていなければ、この見え方で決める
    for (let i = nP; i < P.length; i++) {
      const x = P[i] - NUM_PIECES;
      if (leaf[OFF + x] === 4) leaf[OFF + x] = (A[i] - leaf[TURNS + x] + 4) & 3;
    }
    let path = parent;
    for (let i = 0; i < depth; i++) path = addPath(path, stack[i], step);
    pool.set(key, { s: leaf, cost: c, path });
    if (c < best) best = c;
  };
  // ちょうど target 手の手順を試す（浅い方から順に呼ぶ: 先に見つかった安い説明で、深い枝を落とせる）
  const dfs = (s: Uint8Array, base: number, depth: number, target: number, lastFace: number, parent: number): void => {
    const t = bufs[depth];
    const left = target - depth - 1;
    for (let m = 0; m < 18; m++) {
      const x = (m / 3) | 0;
      if (x === lastFace || (lastFace >= 0 && OPPOSITE[x] === lastFace && x < lastFace)) continue;
      const Q = PERM[m];
      for (let k = 0; k < NUM_PIECES; k++) t[k] = Q[s[k]];
      const c = base + 1;
      if (left > 0) {
        if (c + left + unreach(t, left) > Math.min(best + opt.margin, mine + opt.payback)) continue;
        for (let k = NUM_PIECES; k < SIZE; k++) t[k] = s[k];
        t[TURNS + x] = (t[TURNS + x] + (m % 3) + 1) & 3;
        stack[depth] = m;
        dfs(t, c, depth + 1, target, x, parent);
      } else {
        for (let k = NUM_PIECES; k < SIZE; k++) t[k] = s[k];
        t[TURNS + x] = (t[TURNS + x] + (m % 3) + 1) & 3;
        stack[depth] = m;
        offer(t, c, depth + 1, parent);
      }
    }
  };
  // 空白を越える探索。しっかり見えたピース（2 枚以上見えたもの: 重み 2 枚ぶん以上）の位置だけを追う。後ろ側は「見え方に合う状態」から
  // 逆向きに広げて表にし（見え方ごとに 1 回）、前側は仮説の状態から広げて、同じ位置の組になった所でつなぐ。いちばん短い手順だけ返す
  let bIdx: number[] = []; // 追うピース（P の中の番号）
  let bPos = new Uint8Array(0); // 後ろ側の節点の位置の組（m バイトずつ）
  let bParent = new Int32Array(0);
  let bMove = new Int8Array(0);
  let bDepth = new Uint8Array(0);
  let bCount = 0;
  let bTable = new Map<number, number>();
  let fPos = new Uint8Array(0);
  let fParent = new Int32Array(0);
  let fMove = new Int8Array(0);
  let fDepth = new Uint8Array(0);
  const hashAt = (buf: Uint8Array, off: number, m: number): number => {
    let x = 0x811c9dc5;
    let y = 0x1b873593;
    for (let i = 0; i < m; i++) {
      const v = buf[off + i];
      x = Math.imul(x ^ v, 0x01000193);
      y = Math.imul(y + v, 0x85ebca6b) ^ (y >>> 13);
    }
    return (x >>> 0) * 0x200000 + ((y >>> 0) & 0x1fffff);
  };
  const CAP = 70000;
  const buildBack = (half: number): boolean => {
    bIdx = [];
    for (let i = 0; i < nP; i++) if (W[i] >= opt.frameWeight * 2) bIdx.push(i);
    const m = bIdx.length;
    if (m < opt.bridgePieces) return false;
    if (bPos.length < CAP * m) {
      bPos = new Uint8Array(CAP * 20);
      bParent = new Int32Array(CAP);
      bMove = new Int8Array(CAP);
      bDepth = new Uint8Array(CAP);
      fPos = new Uint8Array(CAP * 20);
      fParent = new Int32Array(CAP);
      fMove = new Int8Array(CAP);
      fDepth = new Uint8Array(CAP);
    }
    bTable = new Map();
    for (let k = 0; k < m; k++) bPos[k] = A[bIdx[k]];
    bParent[0] = -1;
    bMove[0] = -1;
    bDepth[0] = 0;
    bCount = 1;
    bTable.set(hashAt(bPos, 0, m), 0);
    for (let i = 0; i < bCount && bDepth[i] < half; i++) {
      const last = bMove[i] < 0 ? -1 : (bMove[i] / 3) | 0;
      for (let mv = 0; mv < 18 && bCount < CAP; mv++) {
        const x = (mv / 3) | 0;
        if (x === last || (last >= 0 && OPPOSITE[x] === last && x > last)) continue;
        const Q = PERM[inverseMove(mv)];
        const o = bCount * m;
        for (let k = 0; k < m; k++) bPos[o + k] = Q[bPos[i * m + k]];
        const key = hashAt(bPos, o, m);
        if (bTable.has(key)) continue;
        bTable.set(key, bCount);
        bParent[bCount] = i;
        bMove[bCount] = mv;
        bDepth[bCount] = bDepth[i] + 1;
        bCount++;
      }
    }
    expanded += bCount;
    return true;
  };
  const bridge = (from: Uint8Array, minLen: number, half: number): number[][] => {
    const m = bIdx.length;
    const out: number[][] = [];
    let bestLen = Infinity;
    for (let k = 0; k < m; k++) fPos[k] = from[P[bIdx[k]]];
    fParent[0] = -1;
    fMove[0] = -1;
    fDepth[0] = 0;
    let count = 1;
    const seen = new Set<number>([hashAt(fPos, 0, m)]);
    for (let i = 0; i < count; i++) {
      if (fDepth[i] >= bestLen) break;
      const hit = bTable.get(hashAt(fPos, i * m, m));
      if (hit !== undefined) {
        const len = fDepth[i] + bDepth[hit];
        if (len >= minLen && len <= bestLen) {
          if (len < bestLen) {
            bestLen = len;
            out.length = 0;
          }
          const seq: number[] = [];
          for (let p = i; fParent[p] >= 0; p = fParent[p]) seq.push(fMove[p]);
          seq.reverse();
          for (let p = hit; bParent[p] >= 0; p = bParent[p]) seq.push(bMove[p]);
          if (out.length < 32) out.push(seq);
        }
      }
      if (fDepth[i] >= half) continue;
      const last = fMove[i] < 0 ? -1 : (fMove[i] / 3) | 0;
      for (let mv = 0; mv < 18 && count < CAP; mv++) {
        const x = (mv / 3) | 0;
        if (x === last || (last >= 0 && OPPOSITE[x] === last && x < last)) continue;
        const Q = PERM[mv];
        const o = count * m;
        for (let k = 0; k < m; k++) fPos[o + k] = Q[fPos[i * m + k]];
        const key = hashAt(fPos, o, m);
        if (seen.has(key)) continue;
        seen.add(key);
        fParent[count] = i;
        fMove[count] = mv;
        fDepth[count] = fDepth[i] + 1;
        count++;
      }
    }
    expanded += count;
    return out;
  };
  let final: Hyp | null = null;
  const health: number[] = [];
  for (step = 0; step < steps; step++) {
    const last = step === sights.length;
    let maxDepth: number;
    if (last) {
      P = endP;
      A = end!;
      W = endW;
      ALT = null;
      nP = NUM_PIECES;
      maxDepth = opt.endMoves;
    } else {
      const sg = sights[step];
      P = sg.piece;
      A = sg.at;
      W = sg.w;
      ALT = sg.alt ?? null;
      nP = 0;
      while (nP < P.length && P[nP] < NUM_PIECES) nP++;
      const gap = step === 0 ? 0 : Math.abs(sg.t0 - sights[step - 1].t1);
      maxDepth = Math.min(opt.maxMoves, opt.minMoves + Math.floor(gap / opt.msPerMove));
    }
    pool = new Map();
    best = Infinity;
    // 手を入れないものから（候補のコストが早く決まり、枝を落とせる）
    const stay = new Float64Array(cur.length);
    for (let i = 0; i < cur.length; i++) {
      mine = Infinity;
      offer(cur[i].s, cur[i].cost, 0, cur[i].path);
      stay[i] = cur[i].cost + mismatch(cur[i].s);
    }
    const budget = expanded + opt.nodeCap;
    // コストの小さい仮説から（深い手順は上位の仮説だけ）
    const order = Array.from(cur, (_, i) => i).sort((x, y) => stay[x] - stay[y]);
    for (let oi = 0; oi < order.length && expanded < budget; oi++) {
      const i = order[oi];
      const h = cur[i];
      mine = stay[i];
      const deepest = oi < opt.deepHyps ? maxDepth : Math.min(maxDepth, 3);
      for (let L = 1; L <= deepest && expanded < budget; L++) {
        if (h.cost + L + unreach(h.s, L) > Math.min(best + opt.margin, mine + opt.payback)) continue;
        dfs(h.s, h.cost, 0, L, -1, h.path);
      }
    }
    // ふつうの探索で説明がつかなかった: 空白を越える探索
    if (!last && opt.bridgeMoves > maxDepth) {
      let top: Hyp | null = null;
      for (const h of pool.values()) if (!top || h.cost < top.cost) top = h;
      const half = Math.ceil(opt.bridgeMoves / 2);
      if (top && mismatch(top.s) >= opt.stuck && buildBack(opt.bridgeMoves - half)) {
        for (let oi = 0; oi < Math.min(order.length, opt.bridgeHyps); oi++) {
          const h = cur[order[oi]];
          for (const seq of bridge(h.s, maxDepth + 1, half)) {
            const t = h.s.slice();
            for (const mv of seq) {
              const Q = PERM[mv];
              for (let k = 0; k < NUM_PIECES; k++) t[k] = Q[t[k]];
              const x = (mv / 3) | 0;
              t[TURNS + x] = (t[TURNS + x] + (mv % 3) + 1) & 3;
            }
            for (let i = 0; i < seq.length; i++) stack[i] = seq[i];
            mine = Infinity;
            offer(t, h.cost + seq.length, seq.length, h.path);
          }
        }
      }
    }
    let all = [...pool.values()].filter((h) => h.cost <= best + opt.margin);
    if (all.length > opt.beam) {
      all.sort((a, b) => a.cost - b.cost);
      all.length = opt.beam;
    }
    cur = all;
    if (opt.onStep && cur.length) {
      const b = cur.reduce((x, y) => (x.cost <= y.cost ? x : y));
      const ms: number[] = [];
      for (let p = b.path; p >= 0; p = pathParent[p]) ms.push(pathInfo[p] & 31);
      opt.onStep({ back: sights.length > 1 && sights[0].t0 < 0, step, t: last ? Number.NaN : Math.abs(sights[step].t0), pieces: P.length, depth: maxDepth, hyps: cur.length, best, expanded: expanded - budget + opt.nodeCap, moves: ms.reverse() });
    }
    if (last) {
      final = cur.find((h) => end!.every((y, k) => h.s[k] === y)) ?? null;
      break;
    }
    // つなぐために覚える（位置だけの状態ごとに、いちばん安いもの）
    const top = cur.length > opt.keep ? [...cur].sort((a, b) => a.cost - b.cost).slice(0, opt.keep) : cur;
    const set = new Map<number, { cost: number; path: number }>();
    for (const h of top) {
      const k = hashOf(h.s, NUM_PIECES);
      const o = set.get(k);
      if (!o || o.cost > h.cost) set.set(k, { cost: h.cost, path: h.path });
    }
    sets.push(set);
    // 見失ったらやめる
    let bestH = cur[0];
    for (const h of cur) if (h.cost < bestH.cost) bestH = h;
    let len = 0;
    for (let p = bestH ? bestH.path : -1; p >= 0; p = pathParent[p]) len++;
    health.push(bestH ? bestH.cost - len : Infinity);
    if (health.length > opt.lostSteps && health[health.length - 1] - health[health.length - 1 - opt.lostSteps] >= opt.lostCost) break;
    if (stop?.(step, set)) break;
  }
  const moves = (path: number) => {
    const out: { move: number; sight: number }[] = [];
    for (let p = path; p >= 0; p = pathParent[p]) out.push({ move: pathInfo[p] & 31, sight: pathInfo[p] >> 5 });
    return out.reverse();
  };
  return { sets, final, moves, expanded };
}

export function decodePieces(table: PieceTable, start: CubeState, end: CubeState, options: Partial<DecodeOptions> = {}): DecodeResult {
  const opt = { ...DEFAULT_DECODE, ...options };
  const began = performance.now();
  const sights = buildSights(table, opt);
  const n = sights.length;
  const a = fromCubeState(start).pos;
  const b = fromCubeState(end).pos;
  const fw = pass(sights, a, b, opt);
  // 後ろ向き: 見え方を逆順に（時刻の向きも逆）、終わりの状態から。前向きとつながったら、もう少し（より安いつなぎ目があるか）進めてやめる
  const rev = sights.map((s) => ({ ...s, t0: -s.t1, t1: -s.t0 })).reverse();
  let metAt = -1;
  const bw = pass(rev, b, a, opt, (step, set) => {
    const F = fw.sets[n - 1 - step];
    if (metAt < 0 && F) for (const k of set.keys()) if (F.has(k)) metAt = step;
    return metAt >= 0 && step >= metAt + opt.afterMeet;
  });
  const timed = (m: { move: number; sight: number }): DecodedPieceMove => {
    const i = m.sight;
    const before = i > 0 ? sights[Math.min(i, n) - 1].t1 : (sights[0]?.t0 ?? 0);
    const after = i < n ? sights[i].t0 : (sights[n - 1]?.t1 ?? 0);
    return { move: m.move, sight: i, t0: Math.min(before, after), t: after, ...(i >= n || i === 0 ? { inferred: true } : {}) };
  };
  // 後ろ向きの手: 逆順の見え方 j（= 元の n − 1 − j）の前の手は、元の見え方 n − j の前の手。逆向きにして順番も逆に
  const back = (ms: { move: number; sight: number }[]) => ms.map((m) => timed({ move: inverseMove(m.move), sight: n - m.sight })).reverse();
  let best = Infinity;
  let at = -1;
  let fPath = -1;
  let bPath = -1;
  for (let i = 0; i < n; i++) {
    const B = bw.sets[n - 1 - i];
    if (!B) continue;
    for (const [key, x] of fw.sets[i] ?? []) {
      const y = B.get(key);
      if (y && x.cost + y.cost < best) {
        best = x.cost + y.cost;
        at = i;
        fPath = x.path;
        bPath = y.path;
      }
    }
  }
  const info = { sights: n, expanded: fw.expanded + bw.expanded };
  const fCost = fw.final ? fw.final.cost : Infinity;
  const bCost = bw.final ? bw.final.cost : Infinity;
  if (at >= 0 && best <= fCost && best <= bCost) return { ...info, moves: [...fw.moves(fPath).map(timed), ...back(bw.moves(bPath))], reachedEnd: true, method: "meet", cost: best, ms: performance.now() - began };
  if (fw.final && fCost <= bCost) return { ...info, moves: fw.moves(fw.final.path).map(timed), reachedEnd: true, method: "forward", cost: fCost, ms: performance.now() - began };
  if (bw.final) return { ...info, moves: back(bw.moves(bw.final.path)), reachedEnd: true, method: "backward", cost: bCost, ms: performance.now() - began };
  return { ...info, moves: [], reachedEnd: false, method: "none", cost: Infinity, ms: performance.now() - began };
}

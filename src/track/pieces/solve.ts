// ピースの時刻表（table.ts）を条件にして、手順を探す。
// 仮説 = ピース 20 個の位置（+ センターを回した回数）。フレームを時刻順にたどり、フレームとフレームの間に手を入れるかどうかを選ぶ。
//   - コスト = 手の数 + 読みとの食い違い（連なりで分け合った重み）。同じ状態になった仮説は安い方だけ残す
//   - 手を入れるのは「要るとき」だけ: どのピースも、次にそのピースが見える読み（先読み）が分かっている。いまの位置と次の読みが違う
//     ピースを次の読みに近づける手だけを候補にする（見えている層を回すと次のフレームで食い違うので、候補はほとんど出ない）。
//     隠れている層の手は、そのピースが次に見えるまでのどの間に入れてもよいので、見えた手との順番ごとに仮説が分かれ、後の読みで決まる
//   - 並べる順は コスト + 「次の読みまでに最低あと何手要るか」（どのピースも 1 手で 1 回しか動かないので、ピースごとの最小の手数の最大）。
//     先に手を入れた仮説と、まだ入れていない仮説を公平に比べる
// DOM もカメラも知らない
import { type CubeState, OPPOSITE } from "../../cube/model";
import { DIST, NUM_PIECES, PERM, TOUCH, USEFUL, fromCubeState, toCubeState } from "./model";
import { KIND_CHAINED, KIND_SURE, type PieceTable } from "./table";

export interface SolveOptions {
  beam: number; // フレームごとに残す仮説の数
  margin: number; // 一番よい仮説よりこれ以上悪い仮説は捨てる
  moveCost: number;
  hiddenCost: number; // 前後どちらかで層のピースが見えていない手（見えない手）に足すコスト
  seenMs: number; // 層のピースが、回す前の位置に見えていて、手の後これ以内に回した後の位置に見えれば「見えた手」
  nearMs: number; // 近い先読み: これ以内に見える読みのための手は、どの間でも探す
  lookMs: number; // 遠い先読み: これ以内の読みのための手（見えない層の手）は、ほかの手を入れた直後にだけ探す（順番だけが意味を持つ）
  hiddenPerGap: number; // 1 つの間に、間の長さから決まる数を超えて入れてよい見えない層の手
  rotCost: number; // 姿勢がセンターだけでは決まらないフレームで、前と違う姿勢を選ぶコスト（持ち替え。1 手より高く: 見えている 1 面を回したのと区別できないときは手とみる）
  flatWeight: number; // そのとき（表と違う姿勢）の、食い違った読み 1 つのコスト
  runCap: number; // 同じ連なり（同じピースが同じ所に続けて見えた読み）との食い違いの合計の上限
  msPerMove: number; // フレームの間がこれだけ開くごとに、その間に入れてよい手を 1 つ増やす
  maxGapMoves: number; // 1 つの間に入れる手の上限
  minGapMoves: number; // 間が短くても、ここまでは入れてよい（同時に回した 2 つの層・飛ばしたフレーム）
  slack: number; // 食い違ったピースを全部合わせる一番短い手順より、これだけ長い手順まで候補にする
  snapMs: number; // 食い違いの出たフレームからこれ以内のフレームの読みを合わせて、合わせる先にする
  residual: number; // 手を入れた後、そのフレームのほかの読みとの食い違いがこれを超える候補は捨てる
  gapCap: number; // 1 つの仮説・1 つの間から出す候補の上限
  endMoves: number; // 最後（完成）までに足してよい見えない手
  endWeight: number; // 終わりの状態と違うピース 1 個のコスト
  relaxed: boolean; // 次の読みと違うピースの層の手をすべて候補にする（近づく手だけにしない）
  collect?: number; // フレームごとに、上位これだけの仮説（状態・コスト・手の木の節点）を残す（前向きと後ろ向きをつなぐ: meet.ts）
  allow?: (s: Uint8Array) => boolean; // 調査用: この状態の仮説だけ残す（正解の経路のコストを見る）
  trace?: (f: number, hyps: { s: Uint8Array; cost: number; rank: number; path: number }[], movesOf: (path: number) => number[]) => void; // 調査用
}

export const DEFAULT_SOLVE: SolveOptions = { beam: 3000, margin: 4, moveCost: 1, hiddenCost: 0.6, seenMs: 1000, nearMs: 250, lookMs: 3000, hiddenPerGap: 1, rotCost: 1.5, flatWeight: 0.5, runCap: 3, msPerMove: 60, maxGapMoves: 5, minGapMoves: 2, slack: 1, snapMs: 100, residual: 1.5, gapCap: 4000, endMoves: 6, endWeight: 10, relaxed: false };

export interface PieceMove {
  move: number;
  frame: number; // この手を入れた間の後ろのフレーム（frame − 1 と frame の間）
  t0: number; // 回す前の状態が最後に見えた時刻
  t: number; // 回した後の状態が最初に見えた時刻
  orient: number;
  inferred?: boolean; // 前後で見えたピースがなく、ほかの読みから要るとわかった手
}

export interface SolveResult {
  moves: PieceMove[];
  reachedEnd: boolean;
  cost: number;
  mismatch: number; // 食い違いの分
  state: CubeState; // たどり着いた状態
  expanded: number; // 評価した候補の数
  ms: number;
  // collect のとき: フレームごとの仮説（key = ピース 20 個の位置）と、節点から手順を取り出す関数
  sets?: { key: string; cost: number; path: number }[][];
  pathMoves?: (path: number) => { move: number; frame: number; hidden: boolean }[];
}

const KEYED = 32;
const VIOL = 32; // ピース 20 + センター 6: いまの連なりで数えた食い違い（1/20 単位）
const ORI = 58; // センターが 1 つだけのフレームで選んでいる置き方: 基準の面 * 4 + 表の置き方からのずれ（255 = なし）
const SIZE = 59; // 位置 20・センターを回した回数 6・センターの読みの基準 6（4 = まだ読めていない）
const TURNS = 20;
const OFF = 26;

interface Hyp {
  s: Uint8Array;
  cost: number; // 手 + 食い違い
  rank: number; // cost + 先読みの下限
  path: number; // 手の木の節点（-1 = 手なし）
  face: number; // 最後の手の面（この間に入れたものだけ。-1 = なし）
  key: string;
}

export function solvePieces(table: PieceTable, start: CubeState, end: CubeState | null, options: Partial<SolveOptions> = {}): SolveResult {
  const opt = { ...DEFAULT_SOLVE, ...options };
  const began = performance.now();
  const { first, piece, at, w, fresh, solid, byPiece, nextOf, kind, root, altFirst, altPiece, altAt, frameOf } = table;
  const T = table.t;
  const cap20 = Math.round(opt.runCap * 20);
  const n = table.n;
  const endPos = end ? fromCubeState(end).pos : null;
  // 手の木
  let pathParent = new Int32Array(1024);
  let pathInfo = new Int32Array(1024); // 手 + フレーム * 32
  let paths = 0;
  const addPath = (parent: number, move: number, frame: number) => {
    if (paths === pathParent.length) {
      const a = new Int32Array(paths * 2);
      a.set(pathParent);
      pathParent = a;
      const b = new Int32Array(paths * 2);
      b.set(pathInfo);
      pathInfo = b;
    }
    pathParent[paths] = parent;
    pathInfo[paths] = move + frame * 64;
    return paths++;
  };
  let expanded = 0;
  const movesOf = (path: number): number[] => {
    const out: number[] = [];
    for (let p = path; p >= 0; p = pathParent[p]) out.push(pathInfo[p] & 31);
    return out.reverse();
  };

  // フレーム f の読みとの食い違い（センターの基準が決まっていなければ決める）。f = n は終わりの状態
  // ほかの置き方 d（1〜3）での食い違い
  const altCost = (s: Uint8Array, f: number, d: number): number => {
    const from = altFirst[f * 3 + d - 1];
    const to = altFirst[f * 3 + d];
    if (to === from) return Infinity;
    let c = 0;
    for (let i = from; i < to; i++) {
      const p = altPiece[i];
      if (p < NUM_PIECES ? s[p] !== altAt[i] : s[OFF + p - NUM_PIECES] !== 4 && ((s[TURNS + p - NUM_PIECES] + s[OFF + p - NUM_PIECES]) & 3) !== altAt[i]) c += opt.flatWeight;
    }
    return c;
  };
  const frameCost = (s: Uint8Array, f: number): number => {
    if (f === n) {
      let c = 0;
      for (let k = 0; k < NUM_PIECES; k++) if (s[k] !== endPos![k]) c += opt.endWeight;
      return c;
    }
    if (kind[f] === KIND_SURE) {
      s[ORI] = 255;
      return tableCost(s, f);
    }
    // センターが 1 つだけ: 基準の面のまわりの 4 通りを比べる。前のフレームから続く置き方（仮説が選んでいるずれ。なければ表の
    // 置き方）と違うものは持ち替えのコスト。続きが分からないフレームはどれもただ
    const had = s[ORI];
    const pref = kind[f] === KIND_CHAINED ? (had !== 255 && had >> 2 === root[f] ? had & 3 : 0) : -1;
    let best = 0;
    let bestC = Infinity;
    for (let d = 0; d < 4; d++) {
      const c = (d === 0 ? pureCost(s, f) : altCost(s, f, d)) + (pref < 0 || d === pref ? 0 : opt.rotCost);
      if (c < bestC || (c === bestC && d === pref)) {
        bestC = c;
        best = d;
      }
    }
    s[ORI] = root[f] * 4 + best;
    return best === 0 ? tableCost(s, f) + (pref <= 0 ? 0 : opt.rotCost) : bestC;
  };
  // 表の読みとの食い違い（連なりの上限を見ない見積もり）
  const pureCost = (s: Uint8Array, f: number): number => {
    let c = 0;
    for (let j = first[f]; j < first[f + 1]; j++) {
      const p = piece[j];
      if (p < NUM_PIECES ? s[p] !== at[j] : s[OFF + p - NUM_PIECES] !== 4 && ((s[TURNS + p - NUM_PIECES] + s[OFF + p - NUM_PIECES]) & 3) !== at[j]) c += w[j];
    }
    return c;
  };
  const tableCost = (s: Uint8Array, f: number): number => {
    let c = 0;
    for (let j = first[f]; j < first[f + 1]; j++) {
      const p = piece[j];
      if (fresh[j]) s[VIOL + p] = 0;
      let bad: boolean;
      if (p < NUM_PIECES) bad = s[p] !== at[j];
      else {
        const x = p - NUM_PIECES;
        if (s[OFF + x] === 4) s[OFF + x] = (at[j] - s[TURNS + x] + 4) & 3;
        bad = ((s[TURNS + x] + s[OFF + x]) & 3) !== at[j];
      }
      if (!bad) continue;
      const add = Math.min(Math.round(w[j] * 20), cap20 - s[VIOL + p]);
      s[VIOL + p] += add;
      c += add / 20;
    }
    return c;
  };
  // フレーム f より後（f を含む）の次の読みまでに要る手（18 ビット）: nearMask = nearMs 以内に見える読みのため、farMask = lookMs 以内（near を含む）。
  // lower = 最低あと何手か（ピースごとの最小の手数の最大と、合計 / 8 の大きい方。1 手で動くピースは 8 個まで）、total = 残りの手数の合計
  let nearMask = 0;
  let farMask = 0;
  let lower = 0;
  let total = 0;
  const wanted = (s: Uint8Array, f: number): void => {
    nearMask = farMask = lower = total = 0;
    let h = 0;
    if (f >= n) {
      if (!endPos) return;
      for (let k = 0; k < NUM_PIECES; k++) {
        const y = endPos[k];
        if (s[k] === y) continue;
        nearMask |= opt.relaxed ? TOUCH[s[k]] : USEFUL[s[k] * 54 + y];
        const d = DIST[s[k] * 54 + y];
        total += d;
        if (d > h) h = d;
      }
      farMask = nearMask;
      lower = Math.max(h, Math.ceil(total / 8));
      return;
    }
    const tNow = T[f];
    for (let k = 0; k < NUM_PIECES; k++) {
      const L = byPiece[k];
      let i = f === 0 ? 0 : nextOf[k][f - 1];
      // 次の読み（このフレームの読みは 1 枚だけでも使う。先のものは 2 枚以上続いたものだけ）
      while (i < L.length && !solid[L[i]] && frameOf[L[i]] !== f) i++;
      let y: number;
      let dt: number;
      if (i < L.length) {
        dt = T[frameOf[L[i]]] - tNow;
        y = at[L[i]];
      } else if (endPos) {
        dt = T[n - 1] - tNow;
        y = endPos[k];
      } else continue;
      if (s[k] === y || dt > opt.lookMs) continue;
      const m = opt.relaxed ? TOUCH[s[k]] : USEFUL[s[k] * 54 + y];
      const d = DIST[s[k] * 54 + y];
      farMask |= m;
      if (d > h) h = d;
      total += d;
      if (dt <= opt.nearMs) nearMask |= m;
    }
    for (let x = 0; x < 6; x++) {
      if (s[OFF + x] === 4) continue;
      const L = byPiece[NUM_PIECES + x];
      const i = f === 0 ? 0 : nextOf[NUM_PIECES + x][f - 1];
      if (i >= L.length) continue;
      const dt = T[frameOf[L[i]]] - tNow;
      if (dt > opt.lookMs) continue;
      const d = (at[L[i]] - s[TURNS + x] - s[OFF + x] + 8) & 3;
      if (!d) continue;
      farMask |= 1 << (x * 3 + d - 1);
      if (dt <= opt.nearMs) nearMask |= 1 << (x * 3 + d - 1);
      if (h < 1) h = 1;
    }
    // 仮説が表と違う置き方を選んでいるとき: このフレームの読みをその置き方で（表の先読みには出てこない）
    if (kind[f] === KIND_CHAINED && s[ORI] !== 255 && s[ORI] >> 2 === root[f] && (s[ORI] & 3) !== 0) {
      const d = s[ORI] & 3;
      for (let i = altFirst[f * 3 + d - 1]; i < altFirst[f * 3 + d]; i++) {
        const k = altPiece[i];
        if (k >= NUM_PIECES || s[k] === altAt[i]) continue;
        nearMask |= opt.relaxed ? TOUCH[s[k]] : USEFUL[s[k] * 54 + altAt[i]];
        if (h < 1) h = 1;
      }
      farMask |= nearMask;
    }
    lower = Math.max(h, Math.ceil(total / 8));
  };
  // 手 m（フレーム f の前の間に入れる。s は回す前）が「見えた手」か: 層のピース（かセンター）が、前 seenMs 以内に回す前の位置に、
  // 後 seenMs 以内に回した後の位置に見えている
  const witnessed = (s: Uint8Array, m: number, f: number): boolean => {
    if (f >= n) return false;
    const bit = 1 << m;
    const P = PERM[m];
    // 同じピースが、回す前の位置に見えていて、次に（2 枚以上続けて）見えるのが回した後の位置
    for (let k = 0; k < NUM_PIECES; k++) {
      if (!(TOUCH[s[k]] & bit)) continue;
      const L = byPiece[k];
      let i = f === 0 ? 0 : nextOf[k][f - 1];
      if (i === 0 || at[L[i - 1]] !== s[k]) continue;
      while (i < L.length && !solid[L[i]]) i++;
      if (i < L.length && at[L[i]] === P[s[k]] && T[frameOf[L[i]]] - T[f] <= opt.seenMs) return true;
    }
    const x = (m / 3) | 0;
    if (s[OFF + x] === 4) return false;
    const L = byPiece[NUM_PIECES + x];
    const i = f === 0 ? 0 : nextOf[NUM_PIECES + x][f - 1];
    const e = (s[TURNS + x] + s[OFF + x]) & 3;
    return i > 0 && i < L.length && at[L[i - 1]] === e && at[L[i]] === ((e + (m % 3) + 1) & 3) && T[frameOf[L[i]]] - T[f] <= opt.seenMs;
  };
  const keyOf = (s: Uint8Array) => String.fromCharCode.apply(null, s.subarray(0, KEYED) as unknown as number[]);

  const s0 = new Uint8Array(SIZE);
  s0.set(fromCubeState(start).pos);
  s0.fill(4, OFF, OFF + 6);
  s0[ORI] = 255;
  let cur: Hyp[] = [{ s: s0, cost: 0, rank: 0, path: -1, face: -1, key: "" }];
  const pool = new Map<string, Hyp>();
  const offer = (s: Uint8Array, cost: number, path: number, face: number, f: number): Hyp | null => {
    expanded++;
    if (opt.allow && !opt.allow(s)) return null;
    const c = cost + frameCost(s, f);
    const key = keyOf(s);
    const old = pool.get(key);
    if (old && old.cost <= c) return null;
    wanted(s, f + 1);
    const h: Hyp = { s, cost: c, rank: c + lower * opt.moveCost + total * 0.01, path, face, key };
    pool.set(key, h);
    return h;
  };
  const sets: { key: string; cost: number; path: number }[][] | null = opt.collect ? [] : null;
  const pathMoves = (path: number) => {
    const out: { move: number; frame: number; hidden: boolean }[] = [];
    for (let p = path; p >= 0; p = pathParent[p]) out.push({ move: pathInfo[p] & 31, frame: pathInfo[p] >> 6, hidden: (pathInfo[p] & 32) !== 0 });
    return out.reverse();
  };
  const tPiece = new Uint8Array(NUM_PIECES);
  const tAt = new Uint8Array(NUM_PIECES);
  let nT = 0;
  const snap = new Uint8Array(NUM_PIECES);
  const steps = end ? n + 1 : n;
  for (let f = 0; f < steps; f++) {
    pool.clear();
    const gap = f === n ? Infinity : f === 0 ? 0 : table.t[f] - table.t[f - 1];
    const depth = f === n ? opt.endMoves : Math.min(opt.maxGapMoves, opt.minGapMoves + Math.floor(gap / opt.msPerMove));
    for (const h of cur) {
      const base = h.cost;
      const src = h.s;
      // 手を入れない
      offer(src.slice(), base, h.path, -1, f);
      // このフレームで食い違うピース（2 枚以上続いた読みだけ。終わりは全部）を全部合わせる手順を、深さ優先で漏れなく探す。
      // どのピースも、合わせるまでに最低 DIST 手要るので、残りの深さで届かない枝には入らない
      nT = 0;
      let turnsWant = -1;
      if (f === n) {
        for (let k = 0; k < NUM_PIECES; k++)
          if (src[k] !== endPos![k]) {
            tPiece[nT] = k;
            tAt[nT++] = endPos![k];
          }
      } else {
        // このフレームから snapMs 以内のフレームの読みを合わせて 1 枚の「見え方」にする（同じピースが違う所に見えたら、そこで止める）。
        // 長い空白の直後の 1 枚目は読めるピースが少なく、それだけを合わせる短い手順はいくらでもある
        for (let k = 0; k < NUM_PIECES; k++) snap[k] = 255;
        let any = false;
        collect: for (let g = f; g < n && T[g] - T[f] <= opt.snapMs; g++) {
          for (let j = first[g]; j < first[g + 1]; j++) if (solid[j] && piece[j] < NUM_PIECES && snap[piece[j]] !== 255 && snap[piece[j]] !== at[j]) break collect;
          for (let j = first[g]; j < first[g + 1]; j++) if (solid[j] && piece[j] < NUM_PIECES) snap[piece[j]] = at[j];
          if (g === f) for (let k = 0; k < NUM_PIECES; k++) if (snap[k] !== 255 && snap[k] !== src[k]) any = true;
          if (!any) break;
        }
        if (any)
          for (let k = 0; k < NUM_PIECES; k++)
            if (snap[k] !== 255 && snap[k] !== src[k]) {
              tPiece[nT] = k;
              tAt[nT++] = snap[k];
            }
      }
      if (!nT && turnsWant < 0) continue;
      let found = 0;
      let foundAt = -1;
      const stack: number[] = [];
      const dfs = (st: Uint8Array, left: number, lastFace: number, cost: number, path: number): void => {
        if (found >= opt.gapCap) return;
        if (left === 0) {
          for (let i = 0; i < nT; i++) if (st[tPiece[i]] !== tAt[i]) return;
          if (turnsWant >= 0 && ((st[TURNS + (turnsWant >> 2)] - src[TURNS + (turnsWant >> 2)] + 4) & 3) !== (turnsWant & 3)) return;
          // ほかの読みとの食い違いが大きい候補は捨てる（まだ回っていないピースが残るので、少しは許す）
          const leaf = st.slice();
          const c = frameCost(leaf, f);
          if (c > opt.residual && f !== n) return;
          expanded++;
          const key = keyOf(leaf);
          const old = pool.get(key);
          if (old && old.cost <= cost + c) return;
          wanted(leaf, f + 1);
          let pth = path;
          for (let i = 0; i < stack.length; i += 2) pth = addPath(pth, stack[i], f);
          pool.set(key, { s: leaf, cost: cost + c, rank: cost + c + lower * opt.moveCost + total * 0.01, path: pth, face: lastFace, key });
          found++;
          // 見えない層の手（遠い先読みのための手）: ほかの手を入れた直後にだけ試す（順番だけが意味を持つ）
          if (f !== n && opt.hiddenPerGap > 0) {
            wanted(leaf, f);
            let mask = farMask & ~nearMask & ~(7 << (lastFace * 3));
            for (let m = 0; mask; m++, mask >>>= 1) {
              if (!(mask & 1)) continue;
              const s2 = leaf.slice();
              const P = PERM[m];
              for (let k = 0; k < NUM_PIECES; k++) s2[k] = P[s2[k]];
              const x = (m / 3) | 0;
              s2[TURNS + x] = (s2[TURNS + x] + (m % 3) + 1) & 3;
              const c2 = cost + opt.moveCost + opt.hiddenCost;
              const kept = offer(s2, c2 - 0, -2, x, f);
              if (kept) kept.path = addPath(pth, m + 32, f);
            }
          }
          return;
        }
        for (let i = 0; i < nT; i++) if (DIST[st[tPiece[i]] * 54 + tAt[i]] > left) return;
        for (let m = 0; m < 18; m++) {
          const x = (m / 3) | 0;
          if (x === lastFace || (lastFace >= 0 && OPPOSITE[x] === lastFace && x < lastFace)) continue;
          const seen = witnessed(st, m, f);
          const s2 = st.slice();
          const P = PERM[m];
          for (let k = 0; k < NUM_PIECES; k++) s2[k] = P[s2[k]];
          s2[TURNS + x] = (s2[TURNS + x] + (m % 3) + 1) & 3;
          stack.push(m + (seen ? 0 : 32), 0);
          dfs(s2, left - 1, x, cost + opt.moveCost + (seen ? 0 : opt.hiddenCost), path);
          stack.length -= 2;
        }
      };
      for (let L = 1; L <= depth && (foundAt < 0 || L <= foundAt + opt.slack); L++) {
        const before = found;
        dfs(src, L, -1, base, h.path);
        if (found > before && foundAt < 0) foundAt = L;
      }
    }
    // 残す仮説
    let all = [...pool.values()];
    let best = Infinity;
    for (const h of all) if (h.rank < best) best = h.rank;
    all = all.filter((h) => h.rank <= best + opt.margin);
    if (all.length > opt.beam) {
      all.sort((a, b) => a.rank - b.rank);
      all.length = opt.beam;
    }
    cur = all;
    opt.trace?.(f, cur, movesOf);
    if (sets && f < n) {
      const top = cur.length > opt.collect! ? [...cur].sort((a, b) => a.rank - b.rank).slice(0, opt.collect) : cur;
      sets.push(top.map((h) => ({ key: h.key.slice(0, NUM_PIECES), cost: h.cost, path: h.path })));
    }
  }
  let bestH = cur[0];
  for (const h of cur) if (h.cost < bestH.cost) bestH = h;
  // 手順を取り出す
  const moves: PieceMove[] = [];
  for (let p = bestH.path; p >= 0; p = pathParent[p]) {
    const frame = pathInfo[p] >> 6;
    const move = pathInfo[p] & 31;
    const hidden = (pathInfo[p] & 32) !== 0;
    const fr = Math.min(frame, n - 1);
    moves.push({ move, frame, t0: frame > 0 ? table.t[Math.min(frame - 1, n - 1)] : table.t[0], t: table.t[fr], orient: Math.max(0, table.orient[fr]), ...(hidden ? { inferred: true } : {}) });
  }
  moves.reverse();
  const state = toCubeState(bestH.s);
  const reachedEnd = !!endPos && endPos.every((x, k) => bestH.s[k] === x);
  return { moves, reachedEnd, cost: bestH.cost, mismatch: bestH.cost - moves.length * opt.moveCost - moves.filter((m) => m.inferred).length * opt.hiddenCost, state, expanded, ms: performance.now() - began, ...(sets ? { sets, pathMoves } : {}) };
}

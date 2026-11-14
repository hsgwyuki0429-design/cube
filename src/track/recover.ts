// 見失ったところからの復帰（ライブ）: 見失う直前の確かな状態から、後で読めたステッカー（ID）が全部合う手順を探す。
// ライブはフレームを落とすので、速い連続では読める間の状態がないまま 6〜8 手進み、追跡が見失う。作り変え（snap.ts）は見えている面には
// 合わせるが、見えていない面は間違った推測のまま残り、それが見えるたびにまた作り変えて、本当の状態に戻るまで実物で 5〜10 秒かかっていた。
// 読んだステッカーの位置だけを追い、前から half 手・後ろから maxLen − half 手広げて同じ位置の組になった所でつなぐ（精密解析の作り直しで
// 試した「空白を越える探索」: src/track/pieces/decode.ts）。いちばん短い手順で着く状態を全部返す（見えていない所が違う候補も返す: 後の
// 観測で決める）。DOM もカメラも知らない
import { type CubeState, MOVE_DEST, MOVE_SRC, OPPOSITE, VIEW, inverseMove, moveFace } from "../cube/model";
import { PARTNERS, stickerIds } from "../cube/stickers";
import type { Observation } from "./types";

export interface RecoverOptions {
  maxLen: number; // 探す手順の長さの上限
  minIds: number; // 読めたステッカー（センター以外）がこれより少なければ探さない（短い手順で偶然合ってしまう）
  minIdCost: number; // この重さ以上で読めたステッカーだけ使う（FaceObservation.idCost: 引き継いだ ID・弱い読みは軽い）
  cap: number; // 片側で広げる位置の組の上限
  maxResults: number; // 返す状態の上限（これより多ければ決め手がないので返さない）
}

export const DEFAULT_RECOVER: RecoverOptions = { maxLen: 8, minIds: 10, minIdCost: 0.9, cap: 30000, maxResults: 6 };

export interface Recovered {
  state: CubeState;
  orient: number;
  seq: number[];
}

// 観測で読めたステッカーと、姿勢 o のときにあるべき facelet。姿勢と合わない読み（センターの食い違い・種類の違うマス）があれば null
function targetsOf(obs: Observation, o: number, minIdCost: number): { id: number[]; at: number[] } | null {
  const id: number[] = [];
  const at: number[] = [];
  for (const f of obs.faces) {
    if (!f.ids) continue;
    for (let c = 0; c < 9; c++) {
      const s = f.ids[c];
      if (s < 0 || (f.idCost?.[c] ?? 1) < minIdCost) continue;
      const p = VIEW[o * 54 + f.slot * 9 + c];
      if (s % 9 === 4) {
        if (p !== s) return null;
        continue;
      }
      if (PARTNERS[s].length !== PARTNERS[p].length) return null;
      id.push(s);
      at.push(p);
    }
  }
  return { id, at };
}

// 読めたセンターに合う姿勢（センターが読めなければ fallback）
export function orientsOf(obs: Observation, fallback: number[]): number[] {
  const centers: [number, number][] = [];
  for (const f of obs.faces) if (f.ids && f.ids[4] >= 0 && f.ids[4] % 9 === 4) centers.push([f.slot * 9 + 4, f.ids[4]]);
  if (!centers.length) return fallback;
  const out: number[] = [];
  for (let o = 0; o < 24; o++) if (centers.every(([q, s]) => VIEW[o * 54 + q] === s)) out.push(o);
  return out;
}

// FACE_DIST[p * 54 + q]: facelet p のステッカーを facelet q へ運ぶのに要る手の最小の数（届かなければ 99）
const FACE_DIST = (() => {
  const d = new Uint8Array(54 * 54).fill(99);
  for (let p = 0; p < 54; p++) {
    d[p * 54 + p] = 0;
    let frontier = [p];
    for (let k = 1; frontier.length; k++) {
      const next: number[] = [];
      for (const a of frontier)
        for (let m = 0; m < 18; m++) {
          const b = MOVE_DEST[m][a];
          if (d[p * 54 + b] === 99) {
            d[p * 54 + b] = k;
            next.push(b);
          }
        }
      frontier = next;
    }
  }
  return d;
})();

// 位置の組（m バイト）の 32 ビットのハッシュ
const hashOf = (buf: Uint8Array, off: number, m: number): number => {
  let x = 0x811c9dc5;
  for (let i = 0; i < m; i++) x = Math.imul(x ^ buf[off + i], 0x01000193);
  return (x ^ (x >>> 15)) >>> 0;
};

// 節点を同じ位置の組で引く表（開番地法。バイト列そのものを比べる）。以前は 53 ビットのハッシュを Map の鍵にしていて、
// 鍵が小さい整数にならず遅かった（1 回の復帰探索が Node で最大 100ms）
class Index {
  readonly slots: Int32Array;
  readonly mask: number;
  constructor(
    private readonly pos: Uint8Array,
    private readonly m: number,
    cap: number,
  ) {
    let size = 1024;
    while (size < cap * 2) size <<= 1;
    this.slots = new Int32Array(size).fill(-1);
    this.mask = size - 1;
  }
  private same(a: number, buf: Uint8Array, off: number): boolean {
    const pos = this.pos;
    const o = a * this.m;
    for (let k = 0; k < this.m; k++) if (pos[o + k] !== buf[off + k]) return false;
    return true;
  }
  // buf[off..off+m] の節点（なければ -1）
  get(buf: Uint8Array, off: number): number {
    for (let h = hashOf(buf, off, this.m) & this.mask; ; h = (h + 1) & this.mask) {
      const a = this.slots[h];
      if (a < 0) return -1;
      if (this.same(a, buf, off)) return a;
    }
  }
  // 節点 n（pos の中の位置の組）を入れる。同じ組があれば false
  add(n: number): boolean {
    const off = n * this.m;
    for (let h = hashOf(this.pos, off, this.m) & this.mask; ; h = (h + 1) & this.mask) {
      const a = this.slots[h];
      if (a < 0) {
        this.slots[h] = n;
        return true;
      }
      if (this.same(a, this.pos, off)) return false;
    }
  }
}

interface Layer {
  pos: Uint8Array; // 節点ごとに m バイト
  parent: Int32Array;
  move: Int8Array;
  depth: Uint8Array;
  count: number;
  index: Index;
}

// 位置の組 start から、手で広げる（backward なら逆向き: その手を回すと親の組になる位置の組）。other: 反対側の端（前向きなら目的、
// 後ろ向きなら始まり）。どれかのステッカーが、残りの手（total − いまの深さ）では other の位置に届かない組は広げない
function expand(start: Uint8Array, m: number, depth: number, cap: number, backward: boolean, other: Uint8Array, total: number): Layer {
  const pos = new Uint8Array(cap * m);
  const L: Layer = { pos, parent: new Int32Array(cap), move: new Int8Array(cap), depth: new Uint8Array(cap), count: 1, index: new Index(pos, m, cap) };
  pos.set(start);
  L.parent[0] = -1;
  L.move[0] = -1;
  L.index.add(0);
  // 届くかの表を、反対側の端のステッカーごとに引いておく（far[k * 54 + p]: ステッカー k が facelet p から届くのに要る手の数）
  const dist = new Uint8Array(m * 54);
  for (let k = 0; k < m; k++) for (let p = 0; p < 54; p++) dist[k * 54 + p] = backward ? FACE_DIST[other[k] * 54 + p] : FACE_DIST[p * 54 + other[k]];
  for (let i = 0; i < L.count && L.depth[i] < depth; i++) {
    const last = L.move[i] < 0 ? -1 : moveFace(L.move[i]);
    const left = total - L.depth[i] - 1;
    const io = i * m;
    for (let mv = 0; mv < 18 && L.count < cap; mv++) {
      const x = moveFace(mv);
      // 同じ面は続けない・反対の面は決まった順（前向きは番号の小さい方が先。後ろ向きはたどる向きが逆なので大きい方が先）
      if (x === last || (last >= 0 && OPPOSITE[x] === last && (backward ? x > last : x < last))) continue;
      const D = backward ? MOVE_DEST[inverseMove(mv)] : MOVE_DEST[mv];
      const o = L.count * m;
      let far = false;
      for (let k = 0; k < m; k++) {
        const q = D[pos[io + k]];
        if (dist[k * 54 + q] > left) {
          far = true;
          break;
        }
        pos[o + k] = q;
      }
      if (far) continue;
      if (!L.index.add(L.count)) continue;
      L.parent[L.count] = i;
      L.move[L.count] = mv;
      L.depth[L.count] = L.depth[i] + 1;
      L.count++;
    }
  }
  return L;
}

export function recoverFrom(anchor: CubeState, obs: Observation, orients: number[], options: Partial<RecoverOptions> = {}): Recovered[] | null {
  const opt = { ...DEFAULT_RECOVER, ...options };
  const ids = stickerIds(anchor);
  const where = new Int8Array(54).fill(-1);
  for (let f = 0; f < 54; f++) if (ids[f] >= 0) where[ids[f]] = f;
  const out: Recovered[] = [];
  const seen = new Set<string>();
  const front = Math.ceil(opt.maxLen / 2);
  for (const o of orients) {
    const t = targetsOf(obs, o, opt.minIdCost);
    if (!t || t.id.length < opt.minIds) continue;
    const m = t.id.length;
    const start = Uint8Array.from(t.id, (s) => where[s]);
    if (start.some((p) => p < 0)) continue;
    const goal = Uint8Array.from(t.at);
    let reach = 0;
    for (let k = 0; k < m; k++) reach = Math.max(reach, FACE_DIST[start[k] * 54 + goal[k]]);
    if (reach > opt.maxLen) continue;
    const B = expand(goal, m, opt.maxLen - front, opt.cap, true, start, opt.maxLen);
    const F = expand(start, m, front, opt.cap, false, goal, opt.maxLen);
    // いちばん短い手順（0 手 = 見失っていない: 探す意味がない）
    let best = Infinity;
    const hits: [number, number][] = [];
    for (let i = 0; i < F.count; i++) {
      const j = B.index.get(F.pos, i * m);
      if (j < 0) continue;
      const len = F.depth[i] + B.depth[j];
      if (len > best) continue;
      if (len < best) {
        best = len;
        hits.length = 0;
      }
      hits.push([i, j]);
    }
    if (!hits.length || best === 0) continue;
    for (const [i, j] of hits) {
      const seq: number[] = [];
      for (let p = i; F.parent[p] >= 0; p = F.parent[p]) seq.push(F.move[p]);
      seq.reverse();
      for (let p = j; B.parent[p] >= 0; p = B.parent[p]) seq.push(B.move[p]);
      let state = anchor;
      for (const mv of seq) {
        const next = new Uint8Array(54);
        const P = MOVE_SRC[mv];
        for (let k = 0; k < 54; k++) next[k] = state[P[k]];
        state = next;
      }
      const key = `${o}:${state.join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ state, orient: o, seq });
      if (out.length > opt.maxResults) return null;
    }
  }
  return out;
}

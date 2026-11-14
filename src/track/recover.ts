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

const hashOf = (buf: Uint8Array, off: number, m: number): number => {
  let x = 0x811c9dc5;
  let y = 0x1b873593;
  for (let i = 0; i < m; i++) {
    const v = buf[off + i];
    x = Math.imul(x ^ v, 0x01000193);
    y = Math.imul(y + v, 0x85ebca6b) ^ (y >>> 13);
  }
  return (x >>> 0) * 0x200000 + ((y >>> 0) & 0x1fffff);
};

interface Layer {
  pos: Uint8Array; // 節点ごとに m バイト
  parent: Int32Array;
  move: Int8Array;
  depth: Uint8Array;
  count: number;
  index: Map<number, number>;
}

// 位置の組 start から、手で広げる（backward なら逆向き: その手を回すと親の組になる位置の組）。other: 反対側の端（前向きなら目的、
// 後ろ向きなら始まり）。どれかのステッカーが、残りの手（total − いまの深さ）では other の位置に届かない組は広げない
function expand(start: Uint8Array, m: number, depth: number, cap: number, backward: boolean, other: Uint8Array, total: number): Layer {
  const L: Layer = { pos: new Uint8Array(cap * m), parent: new Int32Array(cap), move: new Int8Array(cap), depth: new Uint8Array(cap), count: 1, index: new Map() };
  L.pos.set(start);
  L.parent[0] = -1;
  L.move[0] = -1;
  L.index.set(hashOf(L.pos, 0, m), 0);
  for (let i = 0; i < L.count && L.depth[i] < depth; i++) {
    const last = L.move[i] < 0 ? -1 : moveFace(L.move[i]);
    for (let mv = 0; mv < 18 && L.count < cap; mv++) {
      const x = moveFace(mv);
      // 同じ面は続けない・反対の面は決まった順（前向きは番号の小さい方が先。後ろ向きはたどる向きが逆なので大きい方が先）
      if (x === last || (last >= 0 && OPPOSITE[x] === last && (backward ? x > last : x < last))) continue;
      const D = backward ? MOVE_DEST[inverseMove(mv)] : MOVE_DEST[mv];
      const o = L.count * m;
      for (let k = 0; k < m; k++) L.pos[o + k] = D[L.pos[i * m + k]];
      const left = total - L.depth[i] - 1;
      let far = false;
      for (let k = 0; k < m && !far; k++) far = (backward ? FACE_DIST[other[k] * 54 + L.pos[o + k]] : FACE_DIST[L.pos[o + k] * 54 + other[k]]) > left;
      if (far) continue;
      const key = hashOf(L.pos, o, m);
      if (L.index.has(key)) continue;
      L.index.set(key, L.count);
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
      const j = B.index.get(hashOf(F.pos, i * m, m));
      if (j === undefined) continue;
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

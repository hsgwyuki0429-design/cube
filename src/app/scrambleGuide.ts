// スクランブルの案内: 案内の手順（スクランブル）は作り直さず、いまの状態がどこまで進んだか・ずれていればどう戻すかを求める。
// DOM もカメラも知らない（Node のテストで試せる）。
//
// 以前は、案内の道筋から外れたと見ると 350ms 後に「いまの状態からの最短手順」に作り直していた。作り直しの予約は、その後で
// 道筋に戻っても（U2 を U・U と回した・追跡が途中の形を一瞬拾った）取り消されず、案内が丸ごと別の手順に変わってしまっていた。
import { type CubeState, MOVE_SRC, NUM_MOVES, inverseMove, moveFace } from "../cube/model";

export interface GuidePosition {
  done: number; // 案内のうち済んだ手数（ずれているときは、ずれる前に済んでいた手数）
  half: boolean; // 次の手（半回転）を半分だけ回した（U2 の U だけ）。ずれではない
  fix: number[] | null; // ずれていたら、案内の道筋に戻す手（空 = ずれていない。null = 近くに戻り道が見つからない）
  fixTo: number; // 戻す手を回した後に済んでいる手数
}

const keyOf = (s: CubeState) => String.fromCharCode.apply(null, Array.from(s));

function step(s: CubeState, m: number): CubeState {
  const p = MOVE_SRC[m];
  const out = new Uint8Array(54);
  for (let i = 0; i < 54; i++) out[i] = s[p[i]];
  return out;
}

// 戻り道を探す深さ（3 手まで: 18 + 270 + 4050 通り）
const FIX_DEPTH = 3;

export class ScrambleGuide {
  readonly states: CubeState[];
  private index = new Map<string, number>();
  private cache: { key: string; pos: GuidePosition } | null = null;

  constructor(
    start: CubeState,
    readonly moves: number[],
  ) {
    this.states = [Uint8Array.from(start)];
    for (const m of moves) this.states.push(step(this.states[this.states.length - 1], m));
    // 同じ状態が 2 回出てきたら、先の方（たくさん進んだ方）
    this.states.forEach((s, i) => this.index.set(keyOf(s), i));
  }

  get length(): number {
    return this.moves.length;
  }

  // いまの状態 state の位置。hint: 前に済んでいた手数（半回転の途中・ずれの表示に使う）
  locate(state: CubeState, hint: number): GuidePosition {
    const key = keyOf(state);
    if (this.cache?.key === key && this.cache.pos.done === hint) return this.cache.pos;
    const pos = this.find(state, key, hint);
    this.cache = { key, pos };
    return pos;
  }

  private find(state: CubeState, key: string, hint: number): GuidePosition {
    const on = this.index.get(key);
    if (on !== undefined) return { done: on, half: false, fix: [], fixTo: on };
    // 半回転の途中: 次の手が X2 で、X か X' を 1 回だけ回した
    for (const d of [hint, hint - 1, hint + 1]) {
      const m = this.moves[d];
      if (m === undefined || m % 3 !== 1) continue;
      const face = moveFace(m) * 3;
      if (keyOf(step(this.states[d], face)) === key || keyOf(step(this.states[d], face + 2)) === key) return { done: d, half: true, fix: [], fixTo: d };
    }
    // ずれた: いまの状態から FIX_DEPTH 手以内で案内の道筋のどこかに戻る、いちばん短い手順（同じ長さなら先へ進む方）
    let best: { path: number[]; to: number } | null = null;
    let frontier: { s: CubeState; path: number[] }[] = [{ s: state, path: [] }];
    for (let depth = 1; depth <= FIX_DEPTH && !best; depth++) {
      const next: { s: CubeState; path: number[] }[] = [];
      for (const { s, path } of frontier) {
        const last = path[path.length - 1];
        for (let m = 0; m < NUM_MOVES; m++) {
          if (last !== undefined && moveFace(m) === moveFace(last)) continue;
          const t = step(s, m);
          const p = [...path, m];
          const to = this.index.get(keyOf(t));
          if (to !== undefined && (!best || to > best.to)) best = { path: p, to };
          if (depth < FIX_DEPTH) next.push({ s: t, path: p });
        }
      }
      frontier = next;
    }
    if (best) return { done: Math.min(hint, best.to), half: false, fix: best.path, fixTo: best.to };
    return { done: hint, half: false, fix: null, fixTo: hint };
  }
}

// 案内の道筋から外れた後に回った手 extra（追跡で読めた手）を逆にたどって戻す手順（近くに戻り道が見つからないとき）
export function undoMoves(extra: number[]): number[] {
  const out: number[] = [];
  for (let i = extra.length - 1; i >= 0; i--) {
    const m = inverseMove(extra[i]);
    const last = out[out.length - 1];
    if (last !== undefined && moveFace(last) === moveFace(m)) {
      const q = ((last % 3) + 1 + (m % 3) + 1) % 4;
      out.pop();
      if (q) out.push(moveFace(m) * 3 + q - 1);
    } else out.push(m);
  }
  return out;
}

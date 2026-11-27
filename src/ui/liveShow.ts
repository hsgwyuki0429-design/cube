// ライブの 3D に、追跡の手順をどう見せるか（DOM も three.js も知らない: tests/liveShow.test.ts・tests/debug/liveReplay.debug.test.ts）。
//
// - 足された手は 1 手ずつ回して見せる。ただし**回して見せるのは、その手の層が動いたのをフレームで見た手だけ**（ソルブ中のライブの状態の
//   推定では、さらに候補の状態がどれも同じ手で説明できる手だけ: ShowInput.agreed。分かれている手は AGREE_WAIT_MS まで待って確かめる）（`moveSeen`。追跡の手の
//   MoveTiming.moved: 層の側面のマーカーが本体の格子からずれた。タイマーの開始の判定 src/app/startDetect.ts と同じ手がかり）。
//   見ていない手（持ち替え・傾けで面の割り当てが一瞬入れ替わったのを追跡が手で説明したもの、推定した手）は回さずに、順番が来たら
//   その場で塗り替える。追跡の仮説・手の数え方は変えない（3D の状態は同じで、見せ方だけが違う）
// - 前の手の解釈が変わった・手が溜まったら、回さずにその状態へ切り替える（見えているキューブとずれたまま回し続けない）。足された
//   最後の手だけは回して見せる（層の動きを見ていれば）
// - 作り変え（base・view）はその場でその状態にする
import { applyMoves, solvedState } from "../cube/model";
import type { DecodedMove } from "../track/types";
import type { MoveTiming } from "../track/timing";

export const LIVE_BACKLOG = 2; // 回さずに待たせておく手の数の上限
// ソルブ中のライブの状態の推定（ShowInput.agreed）: 候補の状態が分かれている手は、これだけ待って確かめる（その間に候補がどれも同じ手に
// なれば回して見せ、ならなければ回さずに塗り替える）
export const AGREE_WAIT_MS = 150;

// 3D の側（CubeScene）。setQueue の instant[i] が true の手は回さずに、順番が来たら塗り替える
export interface ShowScene {
  setState(state: ArrayLike<number>): void;
  setQueue(moves: number[], instant?: boolean[]): void;
  waiting(): number; // 待っている手の数（回している手は含まない）
}

export interface ShowInput {
  epoch: number;
  setupMoves: number[] | null;
  moves: number[];
  moveSeen: boolean[]; // moves と同じ並び: その手の層が動いたのをフレームで見た（回して見せてよい）
  base?: { n: number; at: number; state: ArrayLike<number> } | null;
  view?: { n: number; state: ArrayLike<number> } | null;
  // ソルブ中のライブの状態の推定: 候補の状態がどれも同じ手順で説明できる手の数（TrackUpdate.agreed）と、いまの時刻（ms）。
  // これより後の手は AGREE_WAIT_MS まで 3D に出すのを待つ
  agreed?: number;
  now?: number;
}

// 追跡の手のうち、層が動いたのをフレームで見た手（推定した手は見ていない）
export function seenMoves(moves: readonly DecodedMove[], timings: readonly (MoveTiming | null)[] | undefined): boolean[] {
  return moves.map((m, i) => !m.inferred && !!timings?.[i]?.moved);
}

export class LiveShow {
  private key = "";
  private start: Uint8Array = solvedState();
  private shown: number[] = [];
  private arrived = new Map<string, number>(); // 待っている手（番号:手）→ 届いた時刻
  held = false; // 3D に出すのを待っている手がある（AGREE_WAIT_MS 後にもう一度 apply する）

  reset(): void {
    this.key = "";
    this.shown = [];
  }

  apply(s: ShowScene, p: ShowInput): void {
    if (p.setupMoves === null) return;
    const v = p.view;
    const b = p.base;
    let key = `${p.epoch}`;
    let start: ArrayLike<number> | null = null;
    let moves = p.moves;
    let seen = p.moveSeen;
    if (v) {
      key += `:v${v.n}`;
      start = v.state;
      moves = [];
      seen = [];
    } else if (b) {
      key += `:b${b.n}`;
      start = b.state;
      moves = p.moves.slice(b.at);
      seen = p.moveSeen.slice(b.at);
    }
    // 候補が分かれている手は待つ: agreed より後の新しい手は、届いてから AGREE_WAIT_MS たつまで出さない（たったら塗り替える）
    let hold = moves.length;
    const agreedHere = p.agreed === undefined ? undefined : p.agreed - (moves === p.moves ? 0 : p.moves.length - moves.length);
    if (agreedHere !== undefined && p.now !== undefined && this.key === key) {
      const now = p.now;
      const next = new Map<string, number>();
      for (let i = Math.max(0, agreedHere); i < moves.length; i++) {
        const id = `${i}:${moves[i]}`;
        const at = this.arrived.get(id) ?? now;
        next.set(id, at);
        if (i >= this.shown.length && now - at < AGREE_WAIT_MS && hold === moves.length) hold = i;
      }
      this.arrived = next;
    } else this.arrived = new Map();
    const late = new Set<number>(); // 待ったが分かれたままの手（回さない）
    if (agreedHere !== undefined) for (let i = Math.max(0, agreedHere); i < hold; i++) if (i >= this.shown.length) late.add(i);
    this.held = hold < moves.length;
    if (hold < moves.length) {
      moves = moves.slice(0, hold);
      seen = seen.slice(0, hold);
    }
    if (late.size) seen = seen.map((x, i) => x && !late.has(i));
    if (this.key !== key) {
      // 始まりが変わった（スキャン・やり直し・作り変え）: 回さずにその状態にする
      this.key = key;
      this.start = start ? Uint8Array.from(start) : applyMoves(solvedState(), p.setupMoves);
      s.setState(applyMoves(this.start, moves));
      this.shown = [...moves];
      return;
    }
    const old = this.shown;
    let k = 0;
    while (k < old.length && k < moves.length && old[k] === moves[k]) k++;
    const done = old.length - s.waiting(); // 回し終えた（回している）手の数
    const quiet = (from: number) => moves.slice(from).map((_, i) => !seen[from + i]);
    if (k < done || moves.length - done > LIVE_BACKLOG) {
      // 解釈が変わった・手が溜まった: 最後の 1 手の前までは回さずに合わせ、足された最後の手だけ回して見せる
      const appended = k >= old.length && moves.length > k;
      const upto = appended ? moves.length - 1 : moves.length;
      s.setState(applyMoves(this.start, moves.slice(0, upto)));
      s.setQueue(moves.slice(upto), quiet(upto));
    } else {
      s.setQueue(moves.slice(done), quiet(done));
    }
    this.shown = [...moves];
  }
}

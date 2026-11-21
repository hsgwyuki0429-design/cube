// ライブの 3D（src/ui/cubeScene.ts の CubeScene の手の待ち行列）を、時刻を進めて模擬する。src/ui/liveShow.ts の LiveShow に渡して、
// どの手を回して見せたか・その時刻に 3D に出ていた状態（回している層は回す前とみなす）を Node で測る
// （tests/liveShow.test.ts・tests/debug/liveReplay.debug.test.ts の LIVE_ANIM=1）
import { applyMove, moveAmount } from "../src/cube/model";
import type { ShowScene } from "../src/ui/liveShow";
import { turnMs } from "../src/ui/turnTiming";

export interface SimTurn {
  move: number;
  t: number; // 回し始めた（塗り替えた）時刻
  instant: boolean; // 回さずに塗り替えた
}

export class SimScene implements ShowScene {
  state: Uint8Array;
  private queue: { move: number; instant: boolean }[] = [];
  private turn: { move: number; end: number } | null = null;
  private now = 0;
  log: SimTurn[] = [];

  constructor(state: ArrayLike<number>) {
    this.state = Uint8Array.from(state);
  }

  setState(state: ArrayLike<number>): void {
    this.queue = [];
    this.turn = null; // 回している途中の手は回し終えたことにしない（CubeScene.cancelTurns）
    this.state = Uint8Array.from(state);
  }

  setQueue(moves: number[], instant?: boolean[]): void {
    this.queue = moves.map((move, i) => ({ move, instant: !!instant?.[i] }));
  }

  waiting(): number {
    return this.queue.length;
  }

  turning(): boolean {
    return !!this.turn;
  }

  // 時刻 t まで進める（回し終えた手を状態に足し、待っている手を回し始める）
  advance(t: number): void {
    for (;;) {
      if (!this.turn) this.startNext(this.now);
      if (!this.turn || this.turn.end > t) break;
      this.state = applyMove(this.state, this.turn.move);
      this.now = this.turn.end;
      this.turn = null;
    }
    this.now = Math.max(this.now, t);
    if (!this.turn) this.startNext(this.now);
  }

  private startNext(at: number): void {
    while (this.queue[0]?.instant) {
      const q = this.queue.shift()!;
      this.state = applyMove(this.state, q.move);
      this.log.push({ move: q.move, t: at, instant: true });
    }
    const next = this.queue.shift();
    if (!next) return;
    this.turn = { move: next.move, end: at + turnMs(moveAmount(next.move), this.queue.filter((q) => !q.instant).length) };
    this.log.push({ move: next.move, t: at, instant: false });
  }
}

// ライブが読んだマス（止めた後の結果カード・記録の Solve.liveReads）: ライブのフレームの見え方（FrameMessage.sight）でマーカーを直接読めた
// マス（ID があり、マーカーの向きが決まった: sight.ts の rot ≥ 0）を、フレームの撮影時刻とともに直近 LIVE_READS_KEEP_MS だけ残し、
// タイマーの開始〜停止の間を足す。ライブの追跡・判定には使わない。DOM を使わない（tests/liveReads.test.ts）
import type { SightFrame } from "../track/sight";

export const LIVE_READS_KEEP_MS = 200000;

export function directCells(sight: SightFrame | undefined): number {
  if (!sight) return 0;
  let n = 0;
  for (const f of sight.faces) for (let c = 0; c < 9; c++) if ((f.ids[c] ?? -1) >= 0 && (f.rot[c] ?? -1) >= 0) n++;
  return n;
}

export class LiveReads {
  private t: number[] = [];
  private cells: number[] = [];

  // 処理したフレーム 1 枚（見え方がなければ 0 マス）
  push(t: number, sight: SightFrame | undefined): void {
    this.t.push(t);
    this.cells.push(directCells(sight));
    if (this.t.length > 4096 && t - this.t[0] > LIVE_READS_KEEP_MS) {
      let k = 0;
      while (k < this.t.length && t - this.t[k] > LIVE_READS_KEEP_MS) k++;
      this.t.splice(0, k);
      this.cells.splice(0, k);
    }
  }

  // 撮影時刻が [from, to] のフレームの、直接読めたマスの合計とフレームの数
  sum(from: number, to: number): { cells: number; frames: number } {
    let cells = 0;
    let frames = 0;
    for (let i = 0; i < this.t.length; i++)
      if (this.t[i] >= from && this.t[i] <= to) {
        cells += this.cells[i];
        frames++;
      }
    return { cells, frames };
  }
}

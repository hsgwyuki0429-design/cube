// ライブの記録（実機で何が起きたかを手元で再生するため）。認識の Worker が追跡に渡した読み（FrameReading）と、そのときの
// 追跡の結果の要点・処理時間・追跡の設定の変更を、直近 KEEP_MS だけ残す。設定画面の「ライブの記録を書き出す」で書き出し、
// tests/debug/liveLog.debug.test.ts で同じ追跡を通し直す（追跡は読みだけで決まる）。映像は残さない。DOM もカメラも知らない
import type { SightFrame } from "./pieces/frame";
import type { FrameReading } from "./observer";

export const LIVE_LOG_VERSION = 1;
const KEEP_MS = 120000; // 残す長さ（インスペクション + ソルブ 1 回分より長く。1 フレーム 2KB ほどで 1 秒 30 枚なら 7MB ほど）

export interface LoggedOut {
  status: string;
  obsCost: number;
  moves: number; // 一番合う仮説の手の数
  last: number[]; // 一番合う仮説の最後の 4 手
  base: number; // 作り変えの回数（TrackUpdate.base.n）
  view: number; // 3D だけの作り変えの回数（TrackUpdate.view.n。なければ 0）
}

export interface LoggedReading extends FrameReading {
  sight?: SightFrame;
  procMs: number; // 認識にかかった時間
  helper?: boolean; // 補助の Worker で認識した
  dropped?: boolean; // スロットがありえないので追跡には何も見えなかったとして渡した
  out?: LoggedOut; // 観測が出たときの追跡の結果
}

export interface LiveLogEvent {
  t: number; // 直前の読みの時刻（フレームの時間軸）
  kind: "options" | "skip";
  data?: unknown;
}

export interface LiveLogSegment {
  start: number[]; // 追跡を始めた状態
  orients?: number[];
  options: unknown; // 追跡の設定（EngineOptions）
  events: LiveLogEvent[];
  readings: LoggedReading[];
}

export class LiveLog {
  segments: LiveLogSegment[] = [];
  private lastT = 0;
  private skips = 0;

  start(state: ArrayLike<number>, options: unknown, orients?: number[]): void {
    this.flushSkips();
    this.segments.push({ start: Array.from(state), orients, options, events: [], readings: [] });
    this.trim();
  }

  event(kind: LiveLogEvent["kind"], data?: unknown): void {
    const seg = this.segments[this.segments.length - 1];
    if (!seg) return;
    if (kind !== "skip") this.flushSkips();
    seg.events.push({ t: this.lastT, kind, data });
  }

  // 認識の Worker が選ばずに捨てたフレーム（まとめて数える）
  skip(): void {
    this.skips++;
  }

  private flushSkips(): void {
    if (!this.skips) return;
    const n = this.skips;
    this.skips = 0;
    this.event("skip", n);
  }

  add(r: LoggedReading): void {
    const seg = this.segments[this.segments.length - 1];
    if (!seg) return;
    this.flushSkips();
    this.lastT = r.t;
    seg.readings.push(r);
    if (seg.readings.length % 200 === 0) this.trim();
  }

  // KEEP_MS より古い読みと、読みのない古い区切りを捨てる
  private trim(): void {
    const until = this.lastT - KEEP_MS;
    for (const seg of this.segments) {
      let k = 0;
      while (k < seg.readings.length && seg.readings[k].t < until) k++;
      if (k) seg.readings.splice(0, k);
    }
    while (this.segments.length > 1 && !this.segments[0].readings.length) this.segments.shift();
  }

  toJSON(): { version: number; segments: LiveLogSegment[] } {
    this.flushSkips();
    this.trim();
    return { version: LIVE_LOG_VERSION, segments: this.segments };
  }
}

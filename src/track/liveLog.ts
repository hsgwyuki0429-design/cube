// ライブの記録（実機で何が起きたかを手元で再生するため）。認識の Worker が追跡に渡した読み（FrameReading）と、そのときの
// 追跡の結果の要点・処理時間・追跡の設定の変更を、直近 KEEP_MS だけ残す。設定画面の「ライブの記録を書き出す」で書き出し、
// tests/debug/liveLog.debug.test.ts で同じ追跡を通し直す（追跡は読みだけで決まる）。映像は残さない。DOM もカメラも知らない
// 古い読みを捨てるときは、区切りの始まりを「追跡が落ち着いていたときの状態」（TrackerEngine.checkpoint: CHECK_EVERY_MS ごとに取っておく）に
// 進めるので、捨てた後も新しい TrackerEngine で通し直せる（版 2 から。版 1 は捨てても始まりの状態が最初のままで、通し直せなかった）
import type { EngineCheckpoint } from "./engine";
import type { SightFrame } from "./sight";
import type { FrameReading } from "./observer";

export const LIVE_LOG_VERSION = 2;
const KEEP_MS = 120000; // 残す長さ（インスペクション + ソルブ 1 回分より長く。1 フレーム 2KB ほどで 1 秒 30 枚なら 7MB ほど）
const CHECK_EVERY_MS = 3000; // 区切りの始まりの候補を取る間隔
const PIECES_GUARD_MS = 3000; // ソルブ中の推定を始める前のこの長さの候補は使わない（開始の判定の遅れ: Solve.edges.start.lag は 0.3〜1.7 秒）
const HARD_MS = 240000; // 落ち着いた所がないまま、これより長く溜まったら、始まりの状態なしで捨てる

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

// 区切りの途中から通し直すときに TrackerEngine.resume に渡すもの（t = この時刻の読みまで処理した後。手の数は moves から数え直す）
export interface LiveLogResume extends Omit<EngineCheckpoint, "state" | "orients"> {
  t: number;
}

export interface LiveLogSegment {
  start: number[]; // 追跡を始めた状態（resume があれば、その時点の一番の状態）
  orients?: number[];
  options: unknown; // 追跡の設定（EngineOptions。resume があれば、その時点までの設定の変更を合わせたもの）
  resume?: LiveLogResume; // 古い読みを捨てた: この時点から通し直す
  unknownStart?: boolean; // 落ち着いた所がないまま捨てた（始まりの状態が分からない: 通し直しても実機と同じにならない）
  events: LiveLogEvent[];
  readings: LoggedReading[];
  checkpoints?: { t: number; cp: EngineCheckpoint; options: unknown }[]; // 始まりの候補（書き出しには入れない）
}

// 追跡の設定を重ねる（TrackerEngine.setOptions と同じ: decoder・observer・colors は中身を重ね、ほかは置き換える）
export function mergeOptions(a: unknown, b: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { ...((a as Record<string, unknown>) ?? {}) };
  for (const [k, v] of Object.entries((b as Record<string, unknown>) ?? {})) {
    if ((k === "decoder" || k === "observer" || k === "colors") && v && typeof v === "object") out[k] = { ...((out[k] as object) ?? {}), ...(v as object) };
    else out[k] = v;
  }
  return out;
}

export class LiveLog {
  segments: LiveLogSegment[] = [];
  private lastT = 0;
  private skips = 0;
  private options: Record<string, unknown> = {}; // 今の追跡の設定（区切りの設定 + 変更）
  private lastCheck = -Infinity;

  constructor(private readonly keepMs = KEEP_MS) {}

  // options: null = 設定はそのまま（track-reset）
  start(state: ArrayLike<number>, options: unknown, orients?: number[]): void {
    this.flushSkips();
    if (options !== null) this.options = mergeOptions({}, options);
    this.segments.push({ start: Array.from(state), orients, options: this.options, events: [], readings: [], checkpoints: [] });
    this.lastCheck = -Infinity;
    this.trim();
  }

  event(kind: LiveLogEvent["kind"], data?: unknown): void {
    const seg = this.segments[this.segments.length - 1];
    if (!seg) return;
    if (kind !== "skip") this.flushSkips();
    if (kind === "options") {
      this.options = mergeOptions(this.options, data);
      this.lastCheck = -Infinity; // 設定が変わった直後の落ち着いた所を始まりの候補にする（タイマーの場面の切り替わり）
      // ソルブ中の推定（pieces）を始めた: 開始の判定が遅れた分（回し始めてから）に取った候補は使わない（通し直すと推定の始まりの手順が
      // 実機と違い、別の道に入った: 実機の記録 110853 を 20 秒残して通し直したとき）
      if ((data as { pieces?: unknown })?.pieces) seg.checkpoints = (seg.checkpoints ?? []).filter((c) => c.t < this.lastT - PIECES_GUARD_MS);
    }
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

  // checkpoint: 追跡がこの読みを処理した後の TrackerEngine.checkpoint（観測が出たときだけ、CHECK_EVERY_MS ごとに呼ぶ）
  add(r: LoggedReading, checkpoint?: () => EngineCheckpoint | null): void {
    const seg = this.segments[this.segments.length - 1];
    if (!seg) return;
    this.flushSkips();
    this.lastT = r.t;
    seg.readings.push(r);
    if (checkpoint && r.out && r.t - this.lastCheck >= CHECK_EVERY_MS) {
      const cp = checkpoint();
      if (cp) {
        this.lastCheck = r.t;
        (seg.checkpoints ??= []).push({ t: r.t, cp, options: this.options });
      }
    }
    if (seg.readings.length % 200 === 0) this.trim();
  }

  // keepMs より古い読みと、読みのない古い区切りを捨てる。捨てる所は、keepMs より前でいちばん新しい始まりの候補（そこまでの読みと
  // 設定の変更を捨て、区切りの始まりをその状態にする）。候補がなければ捨てない（HARD_MS を超えたら始まりの状態なしで捨てる）
  private trim(): void {
    const until = this.lastT - this.keepMs;
    for (const seg of this.segments) {
      if (!seg.readings.length || seg.readings[0].t >= until) continue;
      const cps = seg.checkpoints ?? [];
      let j = -1;
      for (let i = 0; i < cps.length; i++) if (cps[i].t <= until) j = i;
      if (j >= 0) Object.assign(seg, cutAt(seg, j));
      else if (seg.readings[0].t < this.lastT - HARD_MS) {
        const cut = this.lastT - this.keepMs;
        let k = 0;
        while (k < seg.readings.length && seg.readings[k].t < cut) k++;
        seg.readings.splice(0, k);
        for (const e of seg.events) if (e.t < cut && e.kind === "options") seg.options = mergeOptions(seg.options, e.data);
        seg.events = seg.events.filter((e) => e.t >= cut);
        seg.unknownStart = true;
        seg.checkpoints = [];
      }
    }
    while (this.segments.length > 1 && !this.segments[0].readings.length) this.segments.shift();
  }

  // from: この時刻から通し直せる分だけ（開発用の「書き出す」で 1 回のソルブの分: src/ui/bundleExport.ts）。from より前に終わった区切りは
  // 入れず、from より前から続く区切りは from より前でいちばん新しい始まりの候補から（候補がなければ区切りの始まりから）。記録そのものは変えない
  toJSON(from = -Infinity): { version: number; segments: LiveLogSegment[]; from?: number } {
    this.flushSkips();
    this.trim();
    const strip = ({ checkpoints: _, ...s }: LiveLogSegment) => s;
    if (!Number.isFinite(from)) return { version: LIVE_LOG_VERSION, segments: this.segments.map(strip) };
    const out: LiveLogSegment[] = [];
    for (const seg of this.segments) {
      const rs = seg.readings;
      if (!rs.length || rs[rs.length - 1].t < from) continue;
      const cps = seg.checkpoints ?? [];
      let j = -1;
      for (let i = 0; i < cps.length; i++) if (cps[i].t <= from) j = i;
      out.push(strip(j >= 0 && rs[0].t < from ? { ...seg, ...cutAt(seg, j) } : seg));
    }
    // 読みのない区切りしかない（追跡を始めた直後）: いちばん新しい区切りだけ
    if (!out.length && this.segments.length) out.push(strip(this.segments[this.segments.length - 1]));
    return { version: LIVE_LOG_VERSION, segments: out, from };
  }
}

// 区切りを始まりの候補 j の時点から始まるようにしたもの（その前の読みと設定の変更を捨てる。元の区切りは変えない）
function cutAt(seg: LiveLogSegment, j: number): Partial<LiveLogSegment> {
  const cps = seg.checkpoints ?? [];
  const { t, cp, options } = cps[j];
  let k = 0;
  while (k < seg.readings.length && seg.readings[k].t <= t) k++;
  return {
    checkpoints: cps.slice(j + 1),
    start: cp.state,
    orients: cp.orients,
    options,
    resume: { t, moves: cp.moves, origin: cp.origin, snaps: cp.snaps, refs: cp.refs, lastSeen: cp.lastSeen },
    events: seg.events.filter((e) => e.t >= t),
    readings: seg.readings.slice(k),
  };
}

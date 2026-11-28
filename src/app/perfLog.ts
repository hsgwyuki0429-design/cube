// 1 秒ごとの処理の様子（ライブ 2.5: ソルブ中に fps が落ちる原因を調べる）。カメラのフレーム（requestVideoFrameCallback）の数・画面の
// 更新の数・メインスレッドの遅れ、ライブに送った・送れなかった・処理した枚数、各 Worker の忙しさ（処理していた時間の割合）、録画の
// 圧縮の待ち、精密解析が処理した枚数と遅れを残す。書き出し（ライブの記録・録画）に入れ、手元で tests/debug/fpsPhases.debug.test.ts で
// 場面ごとに並べる。summarizePerf は DOM を使わない（Node で読む）

export interface PerfRow {
  t: number; // この 1 秒の始まり（performance.now() の ms。フレームの時間軸と同じ）
  phase: string; // タイマーの場面（idle・scrambling・inspecting・solving・done）と精密解析（+a = 解析中・+r = 止めた後の残り）
  cam: number; // カメラのフレーム（requestVideoFrameCallback が呼ばれた回数）
  raf: number; // 画面の更新（requestAnimationFrame の回数）
  lag: number; // メインスレッドの遅れの最大（50ms ごとの時計のずれ, ms）
  mainMs: number; // カメラのフレーム 1 枚ごとにメインスレッドで使った時間（送る・録画に足す）の合計（ms）
  msgMs: number; // 認識の結果を受けた処理（ストア・3D・画面）の合計（ms）
  sent: number; // ライブの主の Worker に送った
  sentHelper: number; // 補助の Worker に送った
  full: number; // 結果待ちが上限で送れなかった
  rest: number; // 止めた後の精密解析の間、ライブが休んでいて送らなかった（src/app/liveRest.ts）
  live: number; // 主の Worker が認識した
  helper: number; // 補助の Worker が認識した
  skipped: number; // Worker が待っている中から選ばずに捨てた
  liveBusy: number; // 主の Worker の忙しさ（0〜1。認識 + 追跡）
  helperBusy: number; // 補助の Worker の忙しさ
  rec: number; // 録画に足した
  recDropped: number; // 録画で間引いた
  recMs: number; // 録画に足す処理（描く・圧縮に渡す）の合計（ms）
  recQueue: number; // 圧縮の待ちの最大（フレーム）
  refine: number; // 精密解析が処理した
  decoded: number; // 精密解析が復号した
  refineBusy: number; // 精密解析の Worker の忙しさ（画素にする + 処理）
  behind: number; // 精密解析の遅れ（受け取った録画の最後 − 処理したフレーム, ms。インスペクションのわざと遅らせる分を含む）
}

export interface WorkerPerf {
  busyMs: number; // 累計
  frames: number; // 累計（認識・精密解析した枚数）
  decoded?: number; // 累計（復号した枚数）
  behindMs?: number; // 今の遅れ
}

const KEEP_ROWS = 360;

type Counters = Omit<PerfRow, "t" | "phase" | "liveBusy" | "helperBusy" | "refineBusy" | "behind" | "refine" | "decoded" | "live" | "helper">;
const zero = (): Counters => ({ cam: 0, raf: 0, lag: 0, mainMs: 0, msgMs: 0, sent: 0, sentHelper: 0, full: 0, rest: 0, skipped: 0, rec: 0, recDropped: 0, recMs: 0, recQueue: 0 });

export class PerfLog {
  rows: PerfRow[] = [];
  // 止めた後にライブが休んだ区間（src/app/liveRest.ts の spans を指す）
  rests: import("./liveRest").RestSpan[] = [];
  private c: Counters = zero();
  private t0 = 0;
  private lastTick = 0;
  private prev = new Map<string, { w: WorkerPerf; at: number }>();
  private timer = 0;
  private lagTimer = 0;
  private rafHandle = 0;
  // 呼ぶ側が決める: 今の場面・各 Worker の累計（届いていなければ null）
  phase: () => string = () => "";
  workers: () => Promise<Record<string, WorkerPerf | null>> = async () => ({});

  start(): void {
    if (this.timer || typeof window === "undefined") return;
    this.t0 = performance.now();
    this.lastTick = this.t0;
    this.lagTimer = window.setInterval(() => {
      const now = performance.now();
      this.c.lag = Math.max(this.c.lag, now - this.lastTick - 50);
      this.lastTick = now;
    }, 50);
    const raf = () => {
      this.c.raf++;
      this.rafHandle = requestAnimationFrame(raf);
    };
    this.rafHandle = requestAnimationFrame(raf);
    this.timer = window.setInterval(() => void this.flush(), 1000);
  }

  stop(): void {
    clearInterval(this.timer);
    clearInterval(this.lagTimer);
    cancelAnimationFrame(this.rafHandle);
    this.timer = 0;
  }

  count(key: "cam" | "sent" | "sentHelper" | "full" | "rest" | "skipped" | "rec" | "recDropped", n = 1): void {
    this.c[key] += n;
  }
  addMs(key: "mainMs" | "msgMs" | "recMs", ms: number): void {
    this.c[key] += ms;
  }
  queue(n: number): void {
    this.c.recQueue = Math.max(this.c.recQueue, n);
  }

  private async flush(): Promise<void> {
    const t = this.t0;
    const now = performance.now();
    const c = this.c;
    this.c = zero();
    this.t0 = now;
    const phase = this.phase();
    const ws = await this.workers();
    const at = performance.now();
    // 前に届いた累計との差（届かなかった秒は 0。忙しさは前に届いてからの時間で割る）
    const d = (k: string, f: (w: WorkerPerf) => number) => {
      const w = ws[k];
      if (!w) return 0;
      const p = this.prev.get(k);
      return p ? Math.max(0, f(w) - f(p.w)) : 0;
    };
    const rate = (k: string) => {
      const w = ws[k];
      const p = this.prev.get(k);
      if (!w || !p) return 0;
      return Math.min(1, Math.max(0, w.busyMs - p.w.busyMs) / Math.max(1, at - p.at));
    };
    const row: PerfRow = {
      t: Math.round(t),
      phase,
      ...c,
      lag: Math.round(c.lag),
      mainMs: Math.round(c.mainMs),
      msgMs: Math.round(c.msgMs),
      recMs: Math.round(c.recMs),
      live: d("live", (w) => w.frames),
      helper: d("helper", (w) => w.frames),
      liveBusy: round2(rate("live")),
      helperBusy: round2(rate("helper")),
      refine: d("refine", (w) => w.frames),
      decoded: d("refine", (w) => w.decoded ?? 0),
      refineBusy: round2(rate("refine")),
      behind: Math.round(ws.refine?.behindMs ?? 0),
    };
    for (const [k, w] of Object.entries(ws)) if (w) this.prev.set(k, { w, at });
    this.rows.push(row);
    if (this.rows.length > KEEP_ROWS) this.rows.splice(0, this.rows.length - KEEP_ROWS);
  }

  // 書き出し用: from〜to（ms）の行
  between(from = -Infinity, to = Infinity): PerfRow[] {
    return this.rows.filter((r) => r.t + 1000 >= from && r.t <= to);
  }
}

const round2 = (x: number) => Math.round(x * 100) / 100;

// 行のまとまりの平均（1 秒あたり。忙しさは %）。手元の調査用
export function summarizePerf(rows: PerfRow[]): string {
  if (!rows.length) return "（計測なし）";
  const n = rows.length;
  const avg = (k: keyof PerfRow) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0) / n;
  const max = (k: keyof PerfRow) => rows.reduce((s, r) => Math.max(s, Number(r[k]) || 0), 0);
  const f = (x: number, d = 1) => x.toFixed(d);
  return (
    `${n} 秒: カメラ ${f(avg("cam"))}fps・画面 ${f(avg("raf"))}・メインの遅れ 最大 ${f(max("lag"), 0)}ms・メイン 送る+録画 ${f(avg("mainMs"), 0)}ms/秒（うち録画 ${f(avg("recMs"), 0)}）・結果の処理 ${f(avg("msgMs"), 0)}ms/秒` +
    ` | ライブ 送った ${f(avg("sent"))}+補助 ${f(avg("sentHelper"))}・送れない ${f(avg("full"))}・休み ${f(avg("rest"))}・認識 主 ${f(avg("live"))} 補助 ${f(avg("helper"))}・捨てた ${f(avg("skipped"))}・忙しさ 主 ${f(avg("liveBusy") * 100, 0)}% 補助 ${f(avg("helperBusy") * 100, 0)}%` +
    ` | 録画 ${f(avg("rec"))}・間引き ${f(avg("recDropped"))}・待ち 最大 ${f(max("recQueue"), 0)}` +
    ` | 精密解析 処理 ${f(avg("refine"))}・復号 ${f(avg("decoded"))}・忙しさ ${f(avg("refineBusy") * 100, 0)}%・遅れ 最大 ${f(max("behind") / 1000, 1)} 秒`
  );
}

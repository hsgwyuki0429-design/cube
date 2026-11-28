// 止めた後の精密解析の間、ライブの認識を休む（ライブ 2.5）。休むのは解析が終わるまで（時間では切らない）。ただし利用者が「次のソルブ」を
// 押してタイマーの場面が done から離れたら（preparing・scrambling・idle）休みを解く: 休み中にスクランブルを回すとライブがその手を見ず、
// スクランブル中は作り変えを使わない（controller.setLiveSnap）ので、再開しても追いつけず案内が崩れる。精密解析はそのまま続ける（遅くなってよい）。
// 休みの始まり・終わり・終わった理由を残す（書き出しの perf.rests）。DOM もカメラも知らない（tests/liveRest.test.ts）

export type RestEnd = "result" | "error" | "next" | "guard";

export interface RestSpan {
  t0: number; // 休み始め（performance.now() の ms）
  t1?: number; // 休み終わり
  why?: RestEnd; // result = 解析の結果が出た・error = 解析が失敗した・next = 次のソルブ（done から離れた）・guard = 保険の時間
}

export const LIVE_REST_GUARD_MS = 180000; // 解析が返ってこないときの保険

export class LiveRest {
  readonly spans: RestSpan[] = [];
  private cur: RestSpan | null = null;
  private allowed = false; // タイマーの場面が done（休んでよい）か。done 以外ではそもそも休まない（timer.ts が setPhase で知らせる）
  onChange: ((resting: boolean) => void) | null = null;

  get resting(): boolean {
    return this.cur !== null;
  }

  // 止めた後の解析を始めた（done から離れていたら休まない）。戻り値: 始めた休み（休まなければ null）
  start(t: number): RestSpan | null {
    if (!this.allowed || this.cur) return null;
    this.cur = { t0: t };
    this.spans.push(this.cur);
    if (this.spans.length > 50) this.spans.shift();
    this.onChange?.(true);
    return this.cur;
  }

  // span: この休みだけを解く（前のソルブの解析の終わりで、次のソルブの休みを解かない）
  end(t: number, why: RestEnd, span?: RestSpan | null): void {
    if (!this.cur || (span !== undefined && span !== this.cur)) return;
    this.cur.t1 = t;
    this.cur.why = why;
    this.cur = null;
    this.onChange?.(false);
  }

  // タイマーの場面（done のときだけ休んでよい。離れたら休みを解く）
  setPhase(phase: string, t: number): void {
    this.allowed = phase === "done";
    if (!this.allowed) this.end(t, "next");
  }

  // 保険: 休み始めてから LIVE_REST_GUARD_MS たったら解く
  check(t: number): void {
    if (this.cur && t - this.cur.t0 >= LIVE_REST_GUARD_MS) this.end(t, "guard");
  }
}

/** 移動平均・パーセンタイル。計測表示用。 */
export class Rolling {
  private buf: number[] = [];
  constructor(private cap = 120) {}
  push(v: number): void {
    this.buf.push(v);
    if (this.buf.length > this.cap) this.buf.shift();
  }
  get mean(): number {
    if (!this.buf.length) return NaN;
    let s = 0;
    for (const v of this.buf) s += v;
    return s / this.buf.length;
  }
  percentile(p: number): number {
    if (!this.buf.length) return NaN;
    const a = this.buf.slice().sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor((a.length - 1) * p))];
  }
  get max(): number {
    return this.buf.length ? Math.max(...this.buf) : NaN;
  }
  get count(): number {
    return this.buf.length;
  }
  clear(): void {
    this.buf.length = 0;
  }
}

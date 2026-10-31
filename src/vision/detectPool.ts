// 精密解析の並列化: 検出（OpenCV のマーカー検出。精密解析の時間の 7 割ほど）だけを、認識 Worker のスクリプトを使った別の Worker 何個かに
// 分ける。面の組み立て・読み直し・追跡（フレームの間で引き継ぐもの）は解析の Worker が順に行う（src/vision/refine.ts の gate → full）。
// Worker ごとに OpenCV を読み込むので、1 個あたり 100MB ほど使う
import type { StickerScheme } from "../aruco/codes";
import type { Marker } from "../aruco/detect";
import type { DetectHint } from "./arucoFrame";
import type { PixelSource } from "./image";
import type { FromWorker, ToWorker } from "./protocol";

export interface DetectSettings {
  scheme: StickerScheme;
  design: string;
  thorough: boolean;
}

// 端末のコア数から、検出に使う Worker の数（解析の Worker とライブの認識の分を残す）
export function poolSize(cores = (globalThis.navigator as { hardwareConcurrency?: number } | undefined)?.hardwareConcurrency ?? 4): number {
  return Math.max(0, Math.min(3, cores - 2));
}

export class DetectPool {
  private workers: Worker[] = [];
  private ready: Promise<void>[] = [];
  private busy: number[] = [];
  private next = 1;
  private waiting = new Map<number, (m: Marker[]) => void>();

  constructor(
    size: number,
    private settings: DetectSettings,
  ) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL("./vision.worker.ts", import.meta.url), { type: "module" });
      this.ready.push(
        new Promise((resolve, reject) => {
          w.onmessage = (e: MessageEvent<FromWorker>) => {
            const msg = e.data;
            if (msg.type === "ready") {
              if (msg.opencv) resolve();
              else reject(new Error("検出の Worker で OpenCV を読み込めませんでした"));
            } else if (msg.type === "detected") {
              this.busy[i]--;
              this.waiting.get(msg.id)?.(msg.markers);
              this.waiting.delete(msg.id);
            }
          };
        }),
      );
      w.postMessage({ type: "init" } satisfies ToWorker);
      this.workers.push(w);
      this.busy.push(0);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  // すべての Worker が OpenCV を読み込み終えるまで待つ（読み込めなければ例外: 呼び出し側は並列にせずに続ける）
  async start(): Promise<void> {
    await Promise.all(this.ready);
  }

  // img（写しを送る）で検出する。いちばん空いている Worker に
  detect(img: PixelSource, hint: DetectHint | null): Promise<Marker[]> {
    let k = 0;
    for (let i = 1; i < this.workers.length; i++) if (this.busy[i] < this.busy[k]) k = i;
    const id = this.next++;
    this.busy[k]++;
    const data = new Uint8ClampedArray(img.data);
    const msg: ToWorker = { type: "detect", id, img: { data, width: img.width, height: img.height }, hint, ...this.settings };
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.workers[k].postMessage(msg, [data.buffer]);
    });
  }

  close(): void {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    for (const r of this.waiting.values()) r([]);
    this.waiting.clear();
  }
}

// 並列に検出しながら精密解析に通す: フレームを gate に通し、精密に処理するフレームは検出を Worker に頼んで、終わった順ではなく
// 時刻順に full に渡す（追跡は時刻順でないといけない）。頼んだまま待つフレームは inFlight 枚まで
export class ParallelFeeder {
  private queue: { img: PixelSource; t: number; markers: Promise<Marker[]> }[] = [];
  constructor(
    private refiner: { gate(img: PixelSource, t: number): { img: PixelSource; t: number }[]; detectHint(img: PixelSource, t: number): DetectHint | null; full(img: PixelSource, t: number, detected?: Marker[]): void },
    private detect: (img: PixelSource, hint: DetectHint | null) => Promise<Marker[]>,
    private inFlight: number,
  ) {}

  async push(img: PixelSource, t: number): Promise<void> {
    for (const f of this.refiner.gate(img, t)) this.queue.push({ ...f, markers: this.detect(f.img, this.refiner.detectHint(f.img, f.t)) });
    while (this.queue.length > this.inFlight) await this.take();
  }

  async flush(): Promise<void> {
    while (this.queue.length) await this.take();
  }

  private async take(): Promise<void> {
    const q = this.queue.shift()!;
    this.refiner.full(q.img, q.t, await q.markers);
  }
}

// 止めた後の画面に見せる知らせを、精密解析の Worker の中でまとめて 1 秒 10 回まで送る（形は src/vision/showProtocol.ts）。
// 使うのは精密解析がどのみち出しているもの: 処理したフレームの認識の結果（Refiner.onFrame）と、解き直しの仮説（Refiner.onSearch。
// offline.ts の観測ごとの 1 歩）。解き方・認識は変えない。DOM もカメラも知らない（tests/showFeed.test.ts）
import type { Hypothesis } from "../track/decoder";
import type { SearchStep } from "../track/offline";
import { type DirShow, NEAR_COST, type ReadShow, SHOW_EVERY_MS, type SearchShow, type SearchStage, type ShowMessage } from "./showProtocol";

// 見失っている観測: 一番よい仮説の観測の矛盾がこれ以上（offline.ts の LOST_COST と同じ）。3 つ続いたら、その始まりで「進んだ所」を止める
const LOST_COST = 3;
const LOST_RUN = 3;
// 落とした仮説を数えるとき、いまの仮説の手順をさかのぼる手の数（1 観測に足す手は 4 手まで: offline.ts の maxMovesPerStep）
const ANCESTRY = 6;

type Tail = Hypothesis["tail"];

// 前向き・後ろ向きのどちらかの探索の様子を、観測ごとの仮説から数える
export class DirTracker {
  private reach: number | null = null; // 見失っていない最後の観測の時刻
  private last: number | null = null;
  private lostRun = 0;
  private prev: Tail[] | null = null;
  hyps = 0;
  near = 0;
  dropped = 0;
  steps = 0;

  step(t: number, hyps: readonly Hypothesis[]): void {
    this.steps++;
    // 落とした仮説: 前の観測の仮説のうち、いまの仮説の手順のどれにも（ANCESTRY 手さかのぼって）出てこないもの
    if (this.prev) {
      const alive = new Set<Tail>();
      for (const h of hyps) {
        let n = h.tail;
        for (let d = 0; d <= ANCESTRY; d++) {
          alive.add(n);
          if (!n) break;
          n = n.prev;
        }
      }
      for (const p of this.prev) if (!alive.has(p)) this.dropped++;
    }
    this.prev = hyps.map((h) => h.tail);
    let min = Infinity;
    let bestObs = Infinity;
    for (const h of hyps)
      if (h.cost < min) {
        min = h.cost;
        bestObs = h.obsCost;
      }
    let near = 0;
    for (const h of hyps) if (h.cost - min <= NEAR_COST) near++;
    this.hyps = hyps.length;
    this.near = near;
    this.last = t;
    if (bestObs >= LOST_COST) this.lostRun++;
    else {
      this.lostRun = 0;
      this.reach = t;
    }
  }

  show(): DirShow {
    const t = this.lostRun >= LOST_RUN ? this.reach : this.last;
    return { t, hyps: this.hyps, near: this.near, dropped: this.dropped, steps: this.steps };
  }
}

// 1 フレームの認識の結果（DetectedFace のうち使うものだけ）
export interface ShowFace {
  slot: number;
  ids?: number[];
  shift?: ([number, number] | null)[];
}

// 直接読めたマス（そのマスにマーカーが写っていた: src/ui/readings.ts の direct と同じ）
function directIds(faces: readonly ShowFace[]): { ids: number[]; cells: number } {
  const ids = new Array<number>(45).fill(-1);
  let cells = 0;
  for (const f of faces) {
    if (f.slot < 0 || f.slot > 4 || !f.ids) continue;
    for (let c = 0; c < 9; c++) {
      const id = f.ids[c] ?? -1;
      if (id < 0 || !f.shift?.[c]) continue;
      if (ids[f.slot * 9 + c] < 0) cells++;
      ids[f.slot * 9 + c] = id;
    }
  }
  return { ids, cells };
}

function countDirect(faces: readonly ShowFace[]): number {
  let n = 0;
  for (const f of faces) {
    if (f.slot < 0 || f.slot > 4 || !f.ids) continue;
    for (let c = 0; c < 9; c++) if ((f.ids[c] ?? -1) >= 0 && f.shift?.[c]) n++;
  }
  return n;
}

export class ShowFeed {
  private lastPost = -Infinity;
  private stage: SearchStage | "read" = "read";
  private f = new DirTracker();
  private b = new DirTracker();
  private meetT: number | null = null;
  private step: SearchShow["step"];
  private sum = 0;
  private n = 0;
  private t0 = Infinity;
  private t1 = -Infinity;

  constructor(
    private readonly post: (m: ShowMessage) => void,
    private readonly token: number,
    private readonly frames: () => { done: number; total: number } = () => ({ done: 0, total: 0 }),
    private readonly now: () => number = () => performance.now(),
  ) {}

  // 処理したフレーム（Refiner.onFrame）
  frame(t: number, r: { faces: readonly ShowFace[] }): void {
    this.sum += countDirect(r.faces);
    this.n++;
    if (t < this.t0) this.t0 = t;
    if (t > this.t1) this.t1 = t;
    if (this.stage !== "read") return;
    const now = this.now();
    if (now - this.lastPost < SHOW_EVERY_MS) return;
    this.lastPost = now;
    const { ids, cells } = directIds(r.faces);
    const fr = this.frames();
    const msg: ReadShow = { kind: "read", token: this.token, t, ids, cells, sum: this.sum, n: this.n, t0: this.t0, t1: this.t1, done: fr.done, total: fr.total };
    this.sum = 0;
    this.n = 0;
    this.t0 = Infinity;
    this.t1 = -Infinity;
    this.post(msg);
  }

  // 解き直しの 1 歩（Refiner.onSearch）。read: 録画を読んでいる間に前向きを進めた（OfflineForward）。送らずに数えるだけ
  search(stage: SearchStage | "read", e: SearchStep): void {
    let force = false;
    if (stage !== this.stage && stage !== "read") {
      // 深い 2 回目・止めた時刻での解き直しは前向きからやり直す。1 回目は録画を読みながら進めた前向きをそのまま使う
      if (stage !== "first") this.f = new DirTracker();
      this.b = new DirTracker();
      this.meetT = null;
      this.step = undefined;
      this.stage = stage;
      force = true;
    }
    if (e.dir === "f") this.f.step(e.t, e.hyps);
    else if (e.dir === "b") {
      this.b.step(e.t, e.hyps);
      this.meetT = e.meetT ?? null;
    } else {
      this.step = e.dir;
      force = true;
    }
    if (this.stage === "read") return;
    const now = this.now();
    if (!force && now - this.lastPost < SHOW_EVERY_MS) return;
    this.lastPost = now;
    this.post(this.searchShow());
  }

  // 解き直しが終わった: 最後の様子を送る
  end(): void {
    if (this.stage === "read") return;
    this.post(this.searchShow());
  }

  private searchShow(): SearchShow {
    return { kind: "search", token: this.token, stage: this.stage as SearchStage, f: this.f.show(), b: this.b.show(), meetT: this.meetT, ...(this.step ? { step: this.step } : {}) };
  }
}

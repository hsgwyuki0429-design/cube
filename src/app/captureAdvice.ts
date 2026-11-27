// 撮り方の案内: カメラの映像の見え方（src/vision/captureMetrics.ts）から、直してほしいことを短い文 1 行で出す。一度に 1 つだけ、
// いちばん効くものを出し、直ったら消す。同じ注意を何度も出しすぎない。ソルブ中・インスペクション中は出さない。ぶれ（回している間に
// 読めない）は止まっている間は分からないので、直前のソルブの数字（面が 1 つも組めなかったフレームの割合）からソルブの後に出す。
// しきい値の決め方は docs/history.md の「撮り方の案内」。DOM もカメラも知らない（Node で試験する: tests/captureAdvice.test.ts）
import type { ViewMetrics } from "../vision/captureMetrics";

export type AdviceKey = "center" | "farther" | "closer" | "light" | "angle" | "blurLight" | "blurCloser";

export const ADVICE_TEXT: Record<AdviceKey, string> = {
  center: "キューブを画面の真ん中に",
  farther: "少しカメラから離してください",
  closer: "もう少し近づけてください",
  light: "もう少し明るい場所で",
  angle: "カメラをもう少し低く・横から（2 面が映るように）",
  blurLight: "もう少し明るくすると、回している間も読みやすくなります",
  blurCloser: "もう少し近づけると、回している間も読みやすくなります",
};

// しきい値（長辺 1280 の画素。docs/history.md の「撮り方の案内」で実機の書き出し 4 本と合成の場面から決めた）
export const ADVICE_LIMITS = {
  faceEdgeMin: 200, // いちばん大きく写った面の辺がこれより小さい → 近づける（実機: 150px で精密解析 1/2・350px で 2/2。手元の動画は 300 前後）
  boxMax: 0.92, // 見えている面の囲みの高さが画面の高さのこれより大きい → 離す
  centerMax: 0.3, // 囲みの真ん中が画面の真ん中から（幅・高さの割合で）これより離れている → 真ん中に
  edgeMax: 0.5, // 囲みが画面の端にかかっているフレームの割合がこれより多い → 真ん中に
  // キューブの周りの明るさ（max(R,G,B) の平均）がこれより暗い → 明るく。実機（iPhone）は露出を自動で合わせるので、明るくした回も
  // しない回も 137〜140 だった（暗さはぶれ・雑音に出る: ソルブの後の注意）。露出が追いつかない暗さだけをここで拾う
  darkMax: 75,
  // 2 面以上が写っているフレームの割合がこれより少ない → 低く・横から。実機の 4 本は持っている間 7〜21% で、どれも完成したので、
  // ほとんど 1 面しか写らない置き方（真上・真正面から）だけ
  twoFacesMin: 0.05,
  noFaceMax: 0.3, // ソルブ中に面が 1 つも組めなかったフレームの割合がこれより多い → ソルブの後に（実機: 42〜46% で 1/2・34%・18% で完成）
};

const WINDOW_MS = 3000; // この間の見え方の中央で決める（一瞬の傾け・指では出さない）
const MIN_SAMPLES = 6; // キューブが写っていた見え方がこれだけないと決めない
const SHOW_MAX_MS = 10000; // 直らないまま出しておく長さ。過ぎたら消して、しばらく同じ注意を出さない
const MUTE_MS = 90000; // 直らずに消した注意を、また出すまで
const FIXED_MUTE_MS = 20000; // 直って消えた注意を、また出すまで（直りかけで点いたり消えたりしない）
const MAX_TIMES = 3; // 1 つの注意を出す回数の上限（カメラを開始してから）
const AFTER_SOLVE_MS = 12000; // ソルブの後の注意を出しておく長さ

export interface AdviceSample {
  t: number;
  view: ViewMetrics;
  light?: { cube: number; frame: number };
}

export interface SolveStats {
  frames: number; // ソルブ中に処理したフレーム
  noFace: number; // 面が 1 つも組めなかったフレームの割合
  cells: number; // 1 フレームに ID が読めたマス（平均）
  faceEdge: number; // 面の辺（中央。画素）
  light: number | null; // キューブの周りの明るさ（中央）
}

const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : Number.NaN);

// ソルブ中の見え方から、ソルブの後の案内に使う数字
export function solveStatsOf(rows: { t: number; view: ViewMetrics; cells: number; light?: number }[]): SolveStats {
  const n = rows.length;
  const seen = rows.filter((r) => r.view.faces > 0);
  const lights = rows.map((r) => r.light).filter((x): x is number => x !== undefined);
  return {
    frames: n,
    noFace: n ? 1 - seen.length / n : 0,
    cells: n ? rows.reduce((s, r) => s + r.cells, 0) / n : 0,
    faceEdge: med(seen.map((r) => r.view.faceEdge)),
    light: lights.length ? med(lights) : null,
  };
}

// ソルブの後に出す注意（なければ null）
export function adviceAfterSolve(s: SolveStats, L = ADVICE_LIMITS): AdviceKey | null {
  if (s.frames < 30 || s.noFace <= L.noFaceMax) return null;
  return Number.isFinite(s.faceEdge) && s.faceEdge < L.faceEdgeMin * 1.2 ? "blurCloser" : "blurLight";
}

// 今の見え方の中で、直してほしいこと（優先の高い順に 1 つ）。キューブが写っていなければ null
export function adviceNow(samples: AdviceSample[], L = ADVICE_LIMITS, height = 720): AdviceKey | null {
  const seen = samples.filter((s) => s.view.faces > 0 && s.view.box);
  if (seen.length < MIN_SAMPLES) return null;
  const boxH = med(seen.map((s) => (s.view.box!.y1 - s.view.box!.y0) / height));
  const cx = med(seen.map((s) => s.view.cx));
  const cy = med(seen.map((s) => s.view.cy));
  const edge = seen.filter((s) => s.view.edge).length / seen.length;
  if (boxH > L.boxMax) return "farther";
  if (Math.abs(cx) > L.centerMax || Math.abs(cy) > L.centerMax || edge > L.edgeMax) return "center";
  if (med(seen.map((s) => s.view.faceEdge)) < L.faceEdgeMin) return "closer";
  const lights = seen.map((s) => s.light?.cube).filter((x): x is number => x !== undefined);
  if (lights.length >= MIN_SAMPLES / 2 && med(lights) < L.darkMax) return "light";
  if (seen.filter((s) => s.view.faces >= 2).length / seen.length < L.twoFacesMin) return "angle";
  return null;
}

// 出す・消す・出しすぎないの決まり。update を 1 秒に数回呼ぶ
export class CaptureAdvisor {
  private samples: AdviceSample[] = [];
  private shown: { key: AdviceKey; since: number; after: boolean } | null = null;
  private muted = new Map<AdviceKey, number>(); // この時刻まで出さない
  private times = new Map<AdviceKey, number>();
  private afterSolve: { key: AdviceKey; until: number } | null = null;
  limits = ADVICE_LIMITS;
  height = 720;

  push(s: AdviceSample): void {
    this.samples.push(s);
    while (this.samples.length && s.t - this.samples[0].t > WINDOW_MS) this.samples.shift();
  }

  // ソルブが終わった（t: 止めた時刻）
  solveEnded(stats: SolveStats, t: number): void {
    const key = adviceAfterSolve(stats, this.limits);
    this.afterSolve = key ? { key, until: t + AFTER_SOLVE_MS } : null;
  }

  // 見え方を捨てる（インスペクション・ソルブの間の見え方では決めない。カメラを止めた）
  clear(): void {
    this.samples = [];
  }

  // quiet: 出さない場面（インスペクション・ソルブ中）。返すのは今出す注意（なければ null）
  update(t: number, quiet: boolean): AdviceKey | null {
    if (quiet) {
      this.shown = null;
      this.samples = [];
      return null;
    }
    // ソルブの後の注意（ぶれ）: 決まった長さだけ。その間は今の見え方の注意より先に出す
    if (this.afterSolve && t < this.afterSolve.until) {
      if (!this.shown || this.shown.key !== this.afterSolve.key) this.shown = { key: this.afterSolve.key, since: t, after: true };
      return this.shown.key;
    }
    if (this.afterSolve) {
      this.afterSolve = null;
      this.shown = null;
    }
    const want = adviceNow(this.samples, this.limits, this.height);
    if (this.shown) {
      const cur = this.shown;
      if (want !== cur.key) {
        // 直った（または、もっと先に直すことが出てきた）: 消す。直ったものはしばらく出さない
        this.muted.set(cur.key, t + FIXED_MUTE_MS);
        this.shown = null;
      } else if (t - cur.since > SHOW_MAX_MS) {
        // 直らない: 消して、しばらく出さない
        this.muted.set(cur.key, t + MUTE_MS);
        this.shown = null;
        return null;
      } else return cur.key;
    }
    if (!want || (this.muted.get(want) ?? -Infinity) > t || (this.times.get(want) ?? 0) >= MAX_TIMES) return null;
    this.times.set(want, (this.times.get(want) ?? 0) + 1);
    this.shown = { key: want, since: t, after: false };
    return want;
  }
}

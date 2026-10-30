// 6面スキャン: 手順、1面の取り込み（安定判定）、54枚の色割り当て、状態の組み立てと自動修正。
import { B, D, F, FACES, L, R, U, type CubeState } from "../cube/model";
import { analyzeState, describeProblem, mostLikelyState, type StateProblem } from "../cube/pattern";
import { type Lab, NAMED_COLORS, colorDistance, meanLab, medianLab } from "../vision/color";
import { assignBalanced, hungarian } from "./assign";

// 標準配色（白上・緑前）。面 → 色名
export const STANDARD_SCHEME: Record<number, string> = { [U]: "W", [R]: "R", [F]: "G", [D]: "Y", [L]: "O", [B]: "B" };
const NAME_LABEL: Record<string, string> = Object.fromEntries(NAMED_COLORS.map((c) => [c.id, c.name]));

export interface ScanStep {
  face: number; // キューブ固定フレームの面
  title: string;
  instruction: string;
}

// ArUco マーカーのステッカーは標準配色（白上・緑前）で印刷している
export function scanSteps(): ScanStep[] {
  const s = (face: number, top: number, extra = ""): ScanStep => ({
    face,
    title: `${NAME_LABEL[STANDARD_SCHEME[face]]}の面`,
    instruction: `${NAME_LABEL[STANDARD_SCHEME[face]]}のセンターの面をカメラに向け、${NAME_LABEL[STANDARD_SCHEME[top]]}のセンターを上にしてください。${extra}`,
  });
  return [s(F, U), s(R, U), s(B, U), s(L, U), s(U, B), s(D, F)];
}

// ---- 1面の取り込み ----
//
// 実物では、指がステッカーを隠したり、艶の映り込みが動いたり、面の検出が数フレーム途切れたりする。
// 1 フレームで 9 マスがそろうのを待つのではなく、マスごとに読めたフレームの色をためて、
// どのマスも十分な数の一致した読みがそろったら取り込む（隠れたマスは、見えたときの読みで埋まる）。

export interface CaptureOptions {
  minFrames: number; // 少なくともこの枚数は見る
  minSamples: number; // マスごとに、一致した読みがこれだけそろったら確定
  tolerance: number; // マスの中央値からの許容色差
  minNovelty: number; // 取り込み済みの面の中心色とこれ以上違うこと
  maxMissing: number; // 面が見えないフレームがこれだけ続いたらやり直す
  keep: number; // マスごとにためる読みの数
}

export const DEFAULT_CAPTURE: CaptureOptions = { minFrames: 10, minSamples: 6, tolerance: 14, minNovelty: 16, maxMissing: 24, keep: 30 };

// 読めなかったマス（指でずっと隠れていた）。組み立てのときに、ほかのマスとピースの制約から決める
export const UNKNOWN_LAB: Lab = [Number.NaN, Number.NaN, Number.NaN];
export const isUnknownLab = (l: Lab) => Number.isNaN(l[0]);

export interface CaptureProgress {
  progress: number; // 0..1
  labs?: Lab[]; // 確定したら 9 マスの色
  reason?: "no-face" | "unstable" | "duplicate";
  covered?: boolean[]; // マスごとに読みがそろったか（画面に出す）
}

export interface CaptureReading {
  labs: Lab[];
  valid: boolean[]; // 読めた（手で隠れていない）マス
}

export class FaceCapture {
  private cells: Lab[][] = Array.from({ length: 9 }, () => []);
  private frames = 0;
  private missing = 0;
  private switching = 0;
  options: CaptureOptions;

  constructor(options: Partial<CaptureOptions> = {}) {
    this.options = { ...DEFAULT_CAPTURE, ...options };
  }

  reset(): void {
    this.cells = Array.from({ length: 9 }, () => []);
    this.frames = 0;
    this.missing = 0;
    this.switching = 0;
  }

  private stats() {
    const { tolerance, minSamples } = this.options;
    return this.cells.map((samples) => {
      if (!samples.length) return { med: null as Lab | null, inliers: [] as Lab[], ratio: 0, ok: false };
      const med = medianLab(samples);
      const inliers = samples.filter((l) => colorDistance(l, med) <= tolerance);
      const ratio = inliers.length / samples.length;
      return { med, inliers, ratio, ok: inliers.length >= minSamples && ratio >= 0.6 };
    });
  }

  private progressOf(st: ReturnType<FaceCapture["stats"]>): number {
    const per = st.map((c) => Math.min(1, c.inliers.length / this.options.minSamples) * (c.ratio >= 0.6 ? 1 : 0.5));
    return (per.reduce((a, b) => a + b, 0) / 9) * Math.min(1, this.frames / this.options.minFrames);
  }

  // reading: カメラ正面の面（見つからなければ null）、previousCenters: 取り込み済みの面の中心色
  push(reading: CaptureReading | null, previousCenters: Lab[]): CaptureProgress {
    const o = this.options;
    if (!reading) {
      if (++this.missing > o.maxMissing) this.reset();
      const st = this.stats();
      return { progress: this.progressOf(st), reason: "no-face", covered: st.map((c) => c.ok) };
    }
    this.missing = 0;
    const center = reading.valid[4] ? reading.labs[4] : null;
    const st0 = this.stats();
    const centerMed = st0[4].med;
    // 別の面に変わった（中心の色が大きく違うフレームが続いた）らやり直す
    if (center && centerMed && colorDistance(center, centerMed) > o.tolerance * 2.2) {
      if (++this.switching < 3) return { progress: this.progressOf(st0), reason: "unstable", covered: st0.map((c) => c.ok) };
      this.reset();
    } else this.switching = 0;
    const c = centerMed ?? center;
    if (c && previousCenters.some((p) => colorDistance(p, c) < o.minNovelty)) {
      this.reset();
      return { progress: 0, reason: "duplicate" };
    }
    reading.labs.forEach((lab, i) => {
      if (!reading.valid[i]) return;
      this.cells[i].push(lab);
      if (this.cells[i].length > o.keep) this.cells[i].shift();
    });
    this.frames++;
    const st = this.stats();
    const covered = st.map((x) => x.ok);
    // 指でずっと隠れているマスが 2 つまでなら、しばらく待ってから読めないまま取り込む（中心は必須）
    const partial = this.frames >= o.minFrames * 3 && covered[4] && covered.filter((c) => !c).length <= 2;
    if (this.frames < o.minFrames || (!covered.every(Boolean) && !partial)) return { progress: this.progressOf(st), reason: "unstable", covered };
    const labs = st.map((x) => (x.ok ? medianLab(x.inliers) : UNKNOWN_LAB));
    this.reset();
    return { progress: 1, labs, covered };
  }
}

// ---- 6面の組み立て ----

export interface ScannedFace {
  face: number; // 手順上の面（キューブ固定フレーム）
  labs: Lab[]; // 9 セル（その面のフレームの並び）
}

export interface ScanResult {
  state: CubeState;
  refs: Lab[]; // 面（= 色）ごとの代表色
  names: string[]; // 面ごとの色名（W/Y/R/O/B/G）
  problems: StateProblem[];
  autoFixed: boolean; // 面の向きを自動で直した
  rotations: number[]; // 面ごとに直した回転（90°単位）
  colorWarning?: string;
  cellLabels: number[]; // スキャンした面 i のセル c（i*9+c）が、どの面のセンターと同じ色か（調査・テスト用）
  uncertain: number[]; // 読みと違う色にした、または紛らわしいステッカー（facelet 番号。確認してもらう）
}

// 面のセル番号を 90° 回したときの対応（時計回りに k 回）
export function rotateCells(cells: number[], k: number): number[] {
  let out = [...cells];
  for (let i = 0; i < (k & 3); i++) {
    const c = out;
    // 時計回り: 新しい (r, c) には元の (2-c, r)
    out = Array.from({ length: 9 }, (_, idx) => {
      const r = Math.floor(idx / 3);
      const col = idx % 3;
      return c[(2 - col) * 3 + r];
    });
  }
  return out;
}

export function assembleScan(scanned: ScannedFace[]): ScanResult {
  // 1) 色の割り当て（センターを初期値に、9枚ずつの制約つきで反復）
  const byFace = new Map(scanned.map((s) => [s.face, s]));
  const all: Lab[] = [];
  const owner: { face: number; cell: number }[] = [];
  for (let f = 0; f < 6; f++) {
    const s = byFace.get(f);
    if (!s) throw new Error(`面 ${FACES[f]} が未スキャンです`);
    s.labs.forEach((lab, cell) => {
      all.push(lab);
      owner.push({ face: f, cell });
    });
  }
  let refs: Lab[] = Array.from({ length: 6 }, (_, f) => byFace.get(f)!.labs[4]);
  let labels: number[] = [];
  const known = all.map((lab) => !isUnknownLab(lab));
  for (let iter = 0; iter < 4; iter++) {
    // 読めなかったマスはどの色でも同じコスト（各色 9 枚の数合わせだけに使う）
    labels = assignBalanced(all.map((lab, i) => (known[i] ? refs.map((r) => colorDistance(lab, r)) : [0, 0, 0, 0, 0, 0])));
    // センターは必ず自分の面の色
    owner.forEach((o, i) => {
      if (o.cell === 4) labels[i] = o.face;
    });
    refs = refs.map((r, c) => {
      const members = all.filter((_, i) => known[i] && labels[i] === c);
      return members.length ? meanLab(members) : r;
    });
  }

  // 2) 色名（標準の6色との対応）
  const nameIdx = hungarian(refs.map((r) => NAMED_COLORS.map((n) => colorDistance(r, n.lab))));
  const names = nameIdx.map((i) => NAMED_COLORS[i].id as string);

  // 3) 色名から面の位置を決め直す（標準配色。スキャンの順番を間違えても直る）
  let placement = Array.from({ length: 6 }, (_, f) => f); // 面 f に置くスキャン結果
  const target = [U, R, F, D, L, B].map((f) => STANDARD_SCHEME[f]);
  const pos = names.map((n) => target.indexOf(n));
  if (new Set(pos).size === 6 && pos.every((p) => p >= 0)) placement = Array.from({ length: 6 }, (_, f) => pos.indexOf(f));

  const refsByFace = Array.from({ length: 6 }, (_, f) => refs[placement[f]]);
  const namesByFace = Array.from({ length: 6 }, (_, f) => names[placement[f]]);
  const sep = minSeparation(refsByFace);
  const colorWarning = sep.distance < 14 ? `${colorLabel(namesByFace[sep.pair[0]])}と${colorLabel(namesByFace[sep.pair[1]])}の色が近く、見分けにくい可能性があります。照明を明るくしてください。` : undefined;

  // 4) 物理的にありえるキューブのうち、最も読みに合うものを選ぶ（色を 1 枚ずつ決めるのではなく、
  //    ピースの組み合わせとして決める。白と黄のように紛らわしい色も、ありえるピースの制約で決まる）。
  //    面の向きの取り違え（90° 回して見せた）も、少しの罰をつけて一緒に探す
  // どの色からも遠い読み（隠しきれなかった指・強い映り込み）は、どの色でも同じくらい合わない＝情報なしとして扱う
  const CAP = 32;
  const dist = Array.from({ length: 6 }, (_, src) =>
    Array.from({ length: 9 }, (_, cell) => {
      const lab = all[src * 9 + cell];
      return isUnknownLab(lab) ? [0, 0, 0, 0, 0, 0] : refsByFace.map((r) => Math.min(CAP, colorDistance(lab, r)));
    }),
  );
  const rotIdx = [0, 1, 2, 3].map((r) => rotateCells([0, 1, 2, 3, 4, 5, 6, 7, 8], r));
  const ROT_PENALTY = 8;
  const solve = (rot: number[]) => {
    const cost = (facelet: number, color: number) => {
      const f = Math.floor(facelet / 9);
      return dist[placement[f]][rotIdx[rot[f]][facelet % 9]][color];
    };
    const r = mostLikelyState(cost);
    let lower = 0;
    for (let i = 0; i < 54; i++) if (i % 9 !== 4) lower += Math.min(...[0, 1, 2, 3, 4, 5].map((c) => cost(i, c)));
    return { ...r, lower, score: r.cost + ROT_PENALTY * rot.filter(Boolean).length };
  };
  let rotations = [0, 0, 0, 0, 0, 0];
  let best = solve(rotations);
  // 読みどおりで辻褄が合っていれば（変えた分が小さければ）そのまま。合わなければ面の向きの取り違えも探す
  if (best.cost - best.lower > 12) {
    for (let code = 1; code < 4096; code++) {
      const rot = Array.from({ length: 6 }, (_, f) => (code >> (2 * f)) & 3);
      const r = solve(rot);
      if (r.score < best.score) {
        best = r;
        rotations = rot;
      }
    }
  }
  const state = best.state;
  const problems = analyzeState(state).problems;
  const autoFixed = rotations.some(Boolean);
  // 読みと違う色にしたステッカー（確認してもらう）
  const uncertain: number[] = [];
  for (let i = 0; i < 54; i++) {
    if (i % 9 === 4) continue;
    const f = Math.floor(i / 9);
    const d = dist[placement[f]][rotIdx[rotations[f]][i % 9]];
    const chosen = d[state[i]];
    const second = Math.min(...d.filter((_, c) => c !== state[i]));
    if (chosen > Math.min(...d) + 0.01 || second - chosen < 6 || chosen >= CAP) uncertain.push(i);
  }
  // スキャンした面ごとのセルの色（スキャンした面の番号で）
  const finalLabels = new Array(54).fill(0);
  for (let f = 0; f < 6; f++)
    for (let cell = 0; cell < 9; cell++) finalLabels[placement[f] * 9 + rotIdx[rotations[f]][cell]] = placement[state[f * 9 + cell]];
  void labels;
  return { state, refs: refsByFace, names: namesByFace, problems, autoFixed, rotations, colorWarning, cellLabels: finalLabels, uncertain };
}

function minSeparation(refs: Lab[]) {
  let best = { distance: Infinity, pair: [0, 1] as [number, number] };
  for (let i = 0; i < 6; i++)
    for (let j = i + 1; j < 6; j++) {
      const d = colorDistance(refs[i], refs[j]);
      if (d < best.distance) best = { distance: d, pair: [i, j] };
    }
  return best;
}

export const colorLabel = (id: string) => NAME_LABEL[id] ?? id;

export function problemMessages(problems: StateProblem[], names: string[]): string[] {
  return problems.map((p) => describeProblem(p, (c) => colorLabel(names[c])));
}

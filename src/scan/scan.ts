// 6面スキャン: 手順、1面の取り込み（安定判定）、54枚の色割り当て、状態の組み立てと自動修正。
import { B, D, F, FACES, L, R, U, type CubeState } from "../cube/model";
import { analyzeState, describeProblem, type StateProblem } from "../cube/pattern";
import { type Lab, NAMED_COLORS, colorDistance, meanLab, medianLab } from "../vision/color";
import { assignBalanced, hungarian } from "./assign";

export type Scheme = "standard" | "other";

// 標準配色（白上・緑前）。面 → 色名
export const STANDARD_SCHEME: Record<number, string> = { [U]: "W", [R]: "R", [F]: "G", [D]: "Y", [L]: "O", [B]: "B" };
const NAME_LABEL: Record<string, string> = Object.fromEntries(NAMED_COLORS.map((c) => [c.id, c.name]));

export interface ScanStep {
  face: number; // キューブ固定フレームの面
  title: string;
  instruction: string;
}

export function scanSteps(scheme: Scheme): ScanStep[] {
  if (scheme === "standard") {
    const s = (face: number, top: number, extra = ""): ScanStep => ({
      face,
      title: `${NAME_LABEL[STANDARD_SCHEME[face]]}の面`,
      instruction: `${NAME_LABEL[STANDARD_SCHEME[face]]}のセンターの面をカメラに向け、${NAME_LABEL[STANDARD_SCHEME[top]]}のセンターを上にしてください。${extra}`,
    });
    return [s(F, U), s(R, U), s(B, U), s(L, U), s(U, B), s(D, F)];
  }
  return [
    { face: F, title: "正面", instruction: "好きな面をカメラに向けてください（この面を「正面」にします）。上になっている面を覚えておいてください。" },
    { face: R, title: "右面", instruction: "上の面はそのまま、キューブを上から見て時計回りに90°回してください（あなたから見て左側の面がカメラを向きます）。" },
    { face: B, title: "背面", instruction: "同じ向きにもう90°回してください。" },
    { face: L, title: "左面", instruction: "同じ向きにもう90°回してください。" },
    { face: U, title: "上面", instruction: "正面をカメラに戻してから、上の面がカメラを向くようにキューブをカメラ側へ倒してください。" },
    { face: D, title: "下面", instruction: "正面をカメラに戻してから、下の面がカメラを向くようにキューブを手前へ起こしてください。" },
  ];
}

// ---- 1面の取り込み ----

export interface CaptureOptions {
  frames: number; // この枚数のあいだ色が安定していたら取り込む
  tolerance: number; // セルごとの、中央値からの許容色差
  minNovelty: number; // 取り込み済みの面の中心色とこれ以上違うこと
}

export const DEFAULT_CAPTURE: CaptureOptions = { frames: 12, tolerance: 12, minNovelty: 16 };

export interface CaptureProgress {
  progress: number; // 0..1
  labs?: Lab[]; // 安定したら 9 セルの中央値
  reason?: "no-face" | "unstable" | "duplicate";
}

export class FaceCapture {
  private frames: Lab[][] = [];
  options: CaptureOptions;

  constructor(options: Partial<CaptureOptions> = {}) {
    this.options = { ...DEFAULT_CAPTURE, ...options };
  }

  reset(): void {
    this.frames = [];
  }

  // labs: カメラ正面の面の 9 セル（読めなければ null）、previousCenters: 取り込み済みの面の中心色
  push(labs: Lab[] | null, previousCenters: Lab[]): CaptureProgress {
    if (!labs) {
      this.frames = [];
      return { progress: 0, reason: "no-face" };
    }
    if (previousCenters.some((c) => colorDistance(c, labs[4]) < this.options.minNovelty)) {
      this.frames = [];
      return { progress: 0, reason: "duplicate" };
    }
    this.frames.push(labs);
    if (this.frames.length > this.options.frames) this.frames.shift();
    // 中央値から外れたフレームがあれば、そのフレーム以前を捨てる
    const med = Array.from({ length: 9 }, (_, i) => medianLab(this.frames.map((f) => f[i])));
    for (let k = this.frames.length - 1; k >= 0; k--) {
      const bad = this.frames[k].some((lab, i) => colorDistance(lab, med[i]) > this.options.tolerance);
      if (bad) {
        this.frames = this.frames.slice(k + 1);
        break;
      }
    }
    const progress = this.frames.length / this.options.frames;
    if (this.frames.length < this.options.frames) return { progress, reason: "unstable" };
    const labs9 = Array.from({ length: 9 }, (_, i) => medianLab(this.frames.map((f) => f[i])));
    this.frames = [];
    return { progress: 1, labs: labs9 };
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

export function assembleScan(scanned: ScannedFace[], scheme: Scheme): ScanResult {
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
  for (let iter = 0; iter < 4; iter++) {
    labels = assignBalanced(all.map((lab) => refs.map((r) => colorDistance(lab, r))));
    // センターは必ず自分の面の色
    owner.forEach((o, i) => {
      if (o.cell === 4) labels[i] = o.face;
    });
    refs = refs.map((_, c) => meanLab(all.filter((_, i) => labels[i] === c)));
  }

  // 2) 色名（標準の6色との対応）
  const nameIdx = hungarian(refs.map((r) => NAMED_COLORS.map((n) => colorDistance(r, n.lab))));
  const names = nameIdx.map((i) => NAMED_COLORS[i].id as string);

  // 3) 標準配色なら、色名から面の位置を決め直す（スキャンの順番を間違えても直る）
  let faceOfColor = Array.from({ length: 6 }, (_, c) => c); // 色 c（= スキャンした面 c のセンター色）が属する面
  let placement = Array.from({ length: 6 }, (_, f) => f); // 面 f に置くスキャン結果
  if (scheme === "standard") {
    const target = [U, R, F, D, L, B].map((f) => STANDARD_SCHEME[f]);
    const pos = names.map((n) => target.indexOf(n));
    if (new Set(pos).size === 6 && pos.every((p) => p >= 0)) {
      faceOfColor = pos;
      placement = Array.from({ length: 6 }, (_, f) => pos.indexOf(f));
    }
  }

  const build = (rot: number[]): CubeState => {
    const state = new Uint8Array(54);
    for (let f = 0; f < 6; f++) {
      const src = placement[f];
      const cells = Array.from({ length: 9 }, (_, cell) => faceOfColor[labels[src * 9 + cell]]);
      rotateCells(cells, rot[f]).forEach((c, cell) => (state[f * 9 + cell] = c));
    }
    return state;
  };

  const refsByFace = Array.from({ length: 6 }, (_, f) => refs[placement[f]]);
  const namesByFace = Array.from({ length: 6 }, (_, f) => names[placement[f]]);
  const sep = minSeparation(refsByFace);
  const colorWarning = sep.distance < 14 ? `${colorLabel(namesByFace[sep.pair[0]])}と${colorLabel(namesByFace[sep.pair[1]])}の色が近く、見分けにくい可能性があります。照明を明るくしてください。` : undefined;

  let rotations = [0, 0, 0, 0, 0, 0];
  let state = build(rotations);
  let problems = analyzeState(state).problems;
  let autoFixed = false;
  if (problems.length) {
    // 4) 面の向きの取り違えを探す（回す面が少ない順）
    const combos: number[][] = [];
    for (let code = 1; code < 4096; code++) combos.push(Array.from({ length: 6 }, (_, f) => (code >> (2 * f)) & 3));
    combos.sort((a, b) => a.filter(Boolean).length - b.filter(Boolean).length);
    for (const rot of combos) {
      const s = build(rot);
      if (!analyzeState(s).problems.length) {
        state = s;
        rotations = rot;
        problems = [];
        autoFixed = true;
        break;
      }
    }
  }
  return { state, refs: refsByFace, names: namesByFace, problems, autoFixed, rotations, colorWarning };
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

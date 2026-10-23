// ステッカー状態 ⇄ cubing.js の KPattern、スキャン結果の妥当性チェック。
import { KPattern, type KPuzzle } from "cubing/kpuzzle";
import { cube3x3x3 } from "cubing/puzzles";
import { hungarian } from "../scan/assign";
import { type CubeState, F, FACES, NORMAL, U, D, R, L, B, type Vec3, faceletAt } from "./model";

let kpuzzlePromise: Promise<KPuzzle> | undefined;
export function loadKPuzzle(): Promise<KPuzzle> {
  kpuzzlePromise ??= cube3x3x3.kpuzzle();
  return kpuzzlePromise;
}

// cubing.js の 3x3x3 の並び（Reid 順）
const EDGE_SLOTS: number[][] = [
  [U, F], [U, R], [U, B], [U, L],
  [D, F], [D, R], [D, B], [D, L],
  [F, R], [F, L], [B, R], [B, L],
];
const CORNER_SLOTS: number[][] = [
  [U, F, R], [U, R, B], [U, B, L], [U, L, F],
  [D, R, F], [D, F, L], [D, L, B], [D, B, R],
];

const sumNormals = (faces: number[]): Vec3 =>
  faces.reduce<Vec3>((a, f) => [a[0] + NORMAL[f][0], a[1] + NORMAL[f][1], a[2] + NORMAL[f][2]], [0, 0, 0]);
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// コーナーの3面を、外から見て時計回りに、U/D 面から始めて並べる
function clockwise(faces: number[]): number[] {
  const ud = faces.find((f) => f === U || f === D)!;
  const [a, b] = faces.filter((f) => f !== ud);
  return dot(cross(NORMAL[ud], NORMAL[a]), sumNormals(faces)) < 0 ? [ud, a, b] : [ud, b, a];
}

const EDGE_FACELETS = EDGE_SLOTS.map((slot) => slot.map((f) => faceletAt(sumNormals(slot), NORMAL[f])));
const CORNER_ORDER = CORNER_SLOTS.map(clockwise);
const CORNER_FACELETS = CORNER_ORDER.map((order) => order.map((f) => faceletAt(sumNormals(order), NORMAL[f])));

export type StateProblem =
  | { kind: "count"; color: number; count: number }
  | { kind: "centers" }
  | { kind: "piece"; colors: number[]; facelets: number[] }
  | { kind: "duplicate"; colors: number[]; facelets: number[] }
  | { kind: "twist" }
  | { kind: "flip" }
  | { kind: "parity" };

export function describeProblem(p: StateProblem, colorName: (c: number) => string = (c) => FACES[c]): string {
  switch (p.kind) {
    case "count":
      return `${colorName(p.color)} が ${p.count} 枚あります（9枚のはず）。`;
    case "centers":
      return "センターの色が重複しています。";
    case "piece":
      return `ありえない組み合わせのピース（${p.colors.map(colorName).join("・")}）があります。読み間違いの可能性があります。`;
    case "duplicate":
      return `同じピース（${p.colors.map(colorName).join("・")}）が2つあります。`;
    case "twist":
      return "コーナーが1つねじれています（このままでは揃いません）。";
    case "flip":
      return "エッジが1つ反転しています（このままでは揃いません）。";
    case "parity":
      return "2つのピースが入れ替わった状態です（このままでは揃いません）。";
  }
}

export interface Analysis {
  problems: StateProblem[];
  edges?: { pieces: number[]; orientation: number[] };
  corners?: { pieces: number[]; orientation: number[] };
}

function permutationParity(perm: number[]): number {
  let swaps = 0;
  const seen = new Array(perm.length).fill(false);
  for (let i = 0; i < perm.length; i++) {
    if (seen[i]) continue;
    let len = 0;
    for (let j = i; !seen[j]; j = perm[j]) {
      seen[j] = true;
      len++;
    }
    swaps += len - 1;
  }
  return swaps % 2;
}

// state はキューブ固定フレーム（センター = 面番号）である前提
export function analyzeState(state: CubeState): Analysis {
  const problems: StateProblem[] = [];
  const counts = new Array(6).fill(0);
  for (let i = 0; i < 54; i++) counts[state[i]]++;
  counts.forEach((n, c) => n !== 9 && problems.push({ kind: "count", color: c, count: n }));
  for (let f = 0; f < 6; f++) if (state[f * 9 + 4] !== f) return { problems: [...problems, { kind: "centers" }] };

  const edges = { pieces: [] as number[], orientation: [] as number[] };
  const usedE = new Map<number, number>();
  EDGE_FACELETS.forEach((fl, slot) => {
    const colors = fl.map((i) => state[i]);
    const piece = EDGE_SLOTS.findIndex((s) => (s[0] === colors[0] && s[1] === colors[1]) || (s[0] === colors[1] && s[1] === colors[0]));
    if (piece < 0) return problems.push({ kind: "piece", colors, facelets: fl });
    if (usedE.has(piece)) return problems.push({ kind: "duplicate", colors, facelets: [...fl, ...EDGE_FACELETS[usedE.get(piece)!]] });
    usedE.set(piece, slot);
    edges.pieces.push(piece);
    edges.orientation.push(colors[0] === EDGE_SLOTS[piece][0] ? 0 : 1);
  });

  const corners = { pieces: [] as number[], orientation: [] as number[] };
  const usedC = new Map<number, number>();
  CORNER_FACELETS.forEach((fl, slot) => {
    const colors = fl.map((i) => state[i]);
    const key = [...colors].sort().join();
    const piece = CORNER_SLOTS.findIndex((s) => [...s].sort().join() === key);
    if (piece < 0) return problems.push({ kind: "piece", colors, facelets: fl });
    const home = CORNER_ORDER[piece];
    const twist = colors.indexOf(home[0]);
    const rotated = [0, 1, 2].map((k) => colors[(twist + k) % 3]);
    if (rotated.join() !== home.join()) return problems.push({ kind: "piece", colors, facelets: fl });
    if (usedC.has(piece)) return problems.push({ kind: "duplicate", colors, facelets: [...fl, ...CORNER_FACELETS[usedC.get(piece)!]] });
    usedC.set(piece, slot);
    corners.pieces.push(piece);
    corners.orientation.push(twist);
  });

  if (problems.length) return { problems };
  if (corners.orientation.reduce((a, b) => a + b, 0) % 3 !== 0) problems.push({ kind: "twist" });
  if (edges.orientation.reduce((a, b) => a + b, 0) % 2 !== 0) problems.push({ kind: "flip" });
  if (permutationParity(edges.pieces) !== permutationParity(corners.pieces)) problems.push({ kind: "parity" });
  return { problems, edges, corners };
}

export const isValidState = (state: CubeState) => analyzeState(state).problems.length === 0;

// 色の読みから「物理的にありえるキューブのうち、最も読みに合うもの」を作る。
// cost(facelet, color) = そのステッカーが色 color だとしたときの食い違い（色の距離）。センターは固定。
// エッジ 12 か所・コーナー 8 か所に、それぞれどのピースをどの向きで置くかを割り当て問題として解き（ハンガリアン法）、
// 揃えられる条件（コーナーのねじれ・エッジの反転・偶奇）を、最も安い変更で満たす。
// 各ピースはちょうど 1 回使うので、各色 9 枚も自動的に満たされる。白と黄のように紛らわしい色も、
// 「白と黄のエッジは存在しない」「同じピースは 2 つない」といった制約で決まる。
export function mostLikelyState(cost: (facelet: number, color: number) => number): { state: CubeState; cost: number } {
  // エッジ: [slot][piece][orient]
  const ec = EDGE_FACELETS.map((fl) => EDGE_SLOTS.map((pc) => [cost(fl[0], pc[0]) + cost(fl[1], pc[1]), cost(fl[0], pc[1]) + cost(fl[1], pc[0])]));
  // コーナー: [slot][piece][twist]。colors[j] = home[(j - twist + 3) % 3]
  const cc = CORNER_FACELETS.map((fl) =>
    CORNER_ORDER.map((home) => [0, 1, 2].map((t) => fl.reduce((sum, f, j) => sum + cost(f, home[(j - t + 3) % 3]), 0))),
  );
  const ePiece = hungarian(ec.map((row) => row.map((o) => Math.min(o[0], o[1]))));
  const cPiece = hungarian(cc.map((row) => row.map((t) => Math.min(...t))));
  // 偶奇: エッジとコーナーの置換の偶奇が違えば、2 つのピースを入れ替える（最も安い組）
  if (permutationParity(ePiece) !== permutationParity(cPiece)) {
    let best = { d: Infinity, kind: "e" as "e" | "c", i: 0, j: 0 };
    for (let i = 0; i < 12; i++)
      for (let j = i + 1; j < 12; j++) {
        const d = Math.min(...ec[i][ePiece[j]]) + Math.min(...ec[j][ePiece[i]]) - Math.min(...ec[i][ePiece[i]]) - Math.min(...ec[j][ePiece[j]]);
        if (d < best.d) best = { d, kind: "e", i, j };
      }
    for (let i = 0; i < 8; i++)
      for (let j = i + 1; j < 8; j++) {
        const d = Math.min(...cc[i][cPiece[j]]) + Math.min(...cc[j][cPiece[i]]) - Math.min(...cc[i][cPiece[i]]) - Math.min(...cc[j][cPiece[j]]);
        if (d < best.d) best = { d, kind: "c", i, j };
      }
    const arr = best.kind === "e" ? ePiece : cPiece;
    [arr[best.i], arr[best.j]] = [arr[best.j], arr[best.i]];
  }
  // 向き: それぞれ最も合う向きにしてから、合計の条件を最も安い 1 か所の変更で満たす
  const eOri: number[] = ePiece.map((p, slot) => (ec[slot][p][0] <= ec[slot][p][1] ? 0 : 1));
  if (eOri.reduce((a, b) => a + b, 0) % 2) {
    let bi = 0;
    let bd = Infinity;
    eOri.forEach((o, slot) => {
      const d = ec[slot][ePiece[slot]][1 - o] - ec[slot][ePiece[slot]][o];
      if (d < bd) (bd = d), (bi = slot);
    });
    eOri[bi] = 1 - eOri[bi];
  }
  const cOri = cPiece.map((p, slot) => {
    const t = cc[slot][p];
    return t.indexOf(Math.min(...t));
  });
  const twist = cOri.reduce((a, b) => a + b, 0) % 3;
  if (twist) {
    let bi = 0;
    let bt = 0;
    let bd = Infinity;
    cOri.forEach((o, slot) => {
      const t = (o - twist + 3) % 3; // この角を変えれば合計が 0 になる向き
      const d = cc[slot][cPiece[slot]][t] - cc[slot][cPiece[slot]][o];
      if (d < bd) (bd = d), (bi = slot), (bt = t);
    });
    cOri[bi] = bt;
  }
  const state = new Uint8Array(54);
  for (let f = 0; f < 6; f++) state[f * 9 + 4] = f;
  let total = 0;
  ePiece.forEach((p, slot) => {
    const o = eOri[slot];
    const fl = EDGE_FACELETS[slot];
    state[fl[0]] = EDGE_SLOTS[p][o];
    state[fl[1]] = EDGE_SLOTS[p][1 - o];
    total += ec[slot][p][o];
  });
  cPiece.forEach((p, slot) => {
    const t = cOri[slot];
    const fl = CORNER_FACELETS[slot];
    fl.forEach((f, j) => (state[f] = CORNER_ORDER[p][(j - t + 3) % 3]));
    total += cc[slot][p][t];
  });
  return { state, cost: total };
}

// 妥当な状態を KPattern に（センターはソルブ位置）
export async function stateToPattern(state: CubeState): Promise<KPattern> {
  const a = analyzeState(state);
  if (a.problems.length || !a.edges || !a.corners) throw new Error(a.problems.map((p) => describeProblem(p)).join(" "));
  const kpuzzle = await loadKPuzzle();
  const base = kpuzzle.defaultPattern().patternData;
  return new KPattern(kpuzzle, {
    EDGES: { pieces: a.edges.pieces, orientation: a.edges.orientation },
    CORNERS: { pieces: a.corners.pieces, orientation: a.corners.orientation },
    CENTERS: base.CENTERS,
  });
}

export function patternToState(pattern: KPattern): CubeState {
  const state = new Uint8Array(54);
  for (let f = 0; f < 6; f++) state[f * 9 + 4] = f;
  const e = pattern.patternData.EDGES;
  EDGE_FACELETS.forEach((fl, slot) => {
    const piece = EDGE_SLOTS[e.pieces[slot]];
    const ori = e.orientation[slot];
    fl.forEach((idx, k) => (state[idx] = piece[(k + ori) % 2]));
  });
  const c = pattern.patternData.CORNERS;
  CORNER_FACELETS.forEach((fl, slot) => {
    const home = CORNER_ORDER[c.pieces[slot]];
    const ori = c.orientation[slot];
    fl.forEach((idx, k) => (state[idx] = home[(k - ori + 3) % 3]));
  });
  return state;
}

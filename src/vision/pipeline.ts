// 1フレームの処理: ステッカー検出 → 面の格子 → カメラフレームへの配置 → 色サンプリング → 手のマスク。
// Worker とテストの両方から使う（OpenCV のオブジェクトは呼び出し側が渡す）。
import { stickerScheme } from "../aruco/codes";
import { processAruco } from "./arucoFrame";
import { type Lab, nearestNamed } from "./color";
import { type Mat3, type Pt, applyH, fitHomography, mulH } from "./homography";
import { expandBlocks, largeFaceCandidates } from "./blocks";
import { type LatticeFace, type LatticeOptions, type Quad, findFaces } from "./lattice";
import { type PlacedFace, colAngle, faceArea, layoutFaces, slotPoint } from "./layout";
import { type CV, type QuadOptions, DEFAULT_QUADS, QuadFinder } from "./quads";
import { type PixelSource, sampleFace } from "./sampler";
import { stickerScore } from "./stickerness";
import { skinLike } from "../track/colorModel";
import { rgbToLab } from "./color";
import { pointInPolygon } from "./lattice";
import { defaultFocal, estimatePose, hingePose, projectSlot } from "./pose";

export interface PipelineConfig {
  mode: "auto" | "guide";
  // ステッカーの種類。aruco12 / aruco: 各ステッカーに色付き ArUco マーカー（ID から色が確定する。src/vision/arucoFrame.ts）。
  // aruco12 は 3×3 の 12 種類、aruco は最初に印刷した 4×4 の 54 種類（src/aruco/codes.ts）
  stickers?: "color" | "aruco" | "aruco12" | "unique54";
  arucoThorough?: boolean; // ArUco: 二値化の窓を細かく試す（精密解析。src/aruco/detect.ts の THOROUGH_PARAMS）
  // ArUco: 組み立てた面の読めなかったマスを、切り出して拡大して読み直す数（再認識。src/aruco/reread.ts）。
  // 省略時はライブ 4・精密解析（arucoThorough）は全部
  arucoReread?: number;
  // ArUco: 先に読み直すマス（カメラフレームの slot * 9 + cell）。追跡が未確定・推定とみているマス（TrackerEngine.cellBelief）
  focus?: number[];
  // ArUco: それでも読めなかったマスを色で補う（既定 true。src/aruco/colorFill.ts）
  arucoColorFill?: boolean;
  // ArUco: ID が読めなかったマスに、直前のフレームの同じマスのステッカーを引き継ぐ（既定 true。src/aruco/idTrack.ts）
  arucoIdTrack?: boolean;
  // ArUco: 直前のフレームのマーカーの周りだけを切り出して検出する（精密解析。src/vision/arucoFrame.ts）
  arucoRegion?: boolean;
  guideSize: number; // ガイド枠モード: 短辺に対する枠の大きさ
  region: number; // セル内のサンプリング範囲
  maxSpread: number; // セル内のばらつきがこれ以上なら読まない
  quads: QuadOptions;
  lattice: Partial<LatticeOptions>;
  predictFaces: boolean; // 見つかった面から求めたキューブの姿勢で、見つからなかった隣の面の格子を射影して読む
  // 予測する面の向き（1 = 正対）の下限。寝た面（0.15〜0.3）のセルは細く、ライブで上面が見えるようになるが、
  // 回し終わりの判定を乱すので、ソルブ後の解析では 0.3
  minFacing: number;
  // 隣の面の傾きを、共有する辺を蝶番にして画像に合うよう探す（ライブ）。ソルブ後の解析では求めた姿勢のまま射影し、
  // ステッカーらしさで捨てない（実際の動画で、探すと前後からつなげなくなった）
  hingeSearch: boolean;
  // 窓の位置が曖昧な面は、ずらした格子での読みも付ける（ソルブ後の解析）。前後からつなぐ解析では、実際の T-perm の
  // 動画（8 秒）がこれでつながる。ライブの前向きの追跡では、選べる読みが増えると雑音を誤った手で説明しやすくなり、
  // 同じ動画で 14 手正しかったのが 7 手目以降で崩れたので使わない
  altReadings: boolean;
  // 面が見つからないとき、溝で区切った候補でやり直す（1 フレームの処理が 2〜5 倍になるので、ソルブ後の解析だけ）
  grooveRetry: boolean;
  // 画像が大きなフレームの一部（切り出し）のとき、そのフレーム全体のこの画像の座標での位置と大きさ。フレームに対する
  // 割合で決めるしきい値（四角形の面積・二値化の窓・模様の範囲・中央の大きな面）と、姿勢の計算（画像の中心・焦点距離）は
  // フレーム全体を基準にする。切り出しを基準にすると、回転途中の層や背景の格子が面として通っていた
  frame?: FrameRef;
}

export interface FrameRef {
  width: number;
  height: number;
  ox: number; // フレームの左上（この画像の座標）
  oy: number;
}

export const DEFAULT_PIPELINE: PipelineConfig = {
  mode: "auto",
  guideSize: 0.6,
  region: 0.6,
  maxSpread: 60,
  quads: DEFAULT_QUADS,
  lattice: {},
  predictFaces: true,
  minFacing: 0.15,
  hingeSearch: true,
  altReadings: false,
  grooveRetry: false,
};

export interface DetectedFace {
  slot: number;
  rot: number;
  held?: boolean; // このフレームでは検出できず、直前の位置を使った
  H: Mat3;
  found: number;
  labs: Lab[];
  spread: number[];
  valid: boolean[];
  weight: number[]; // セルの信頼度（四角形が見つかったセル 1、格子から推定したセル・保持した面は低め）
  masked: boolean[]; // 手で隠れている
  // 窓の位置が一意に決まらなかったとき、1 段ずらした格子での読み（どちらが正しいかはデコーダが状態と照らして決める）
  alts?: { labs: Lab[]; valid: boolean[] }[];
  ids?: number[]; // ArUco ステッカー（マスごとに違う符号）: 読んだステッカーの ID（揃った状態での facelet 番号。-1 = 不明）
}

export interface FrameResult {
  faces: DetectedFace[];
  quads: Pt[][]; // デバッグ表示用
}

// アンカー（カメラ正面）の向きと中心色を、フレーム間で引き継ぐ
export interface PipelineMemory {
  t: number;
  angle: number;
  centerKey: number; // 中心色（代表色が分かっていればその番号、なければ名前付き色の番号）
  pitch: number; // ステッカー間隔（px）。ステッカーレスのブロック分割に使う
  faces: KeptFace[]; // 直前の面（短時間の保持・ブロック分割・窓の位置の曖昧さの解消に使う）
  hinge?: Record<number, number>; // 隣の面を予測したときの蝶番の角度（スロットごと）
}

type KeptFace = PlacedFace & { seenT: number }; // seenT: 最後に実際に検出できた時刻

const MAX_ALTS = 2; // ずらした格子の候補の数
const SKIP_MS = 300; // 正面が指で隠れたフレームを飛ばすのは、直前に正面が見えてからこの時間まで
const HOLD_MS = 400; // 何も見つからないとき、直前の面を使い続ける時間
const CARRY_MS = 2500; // 正面を追えている間、見つからない他の面を運び続ける時間

export function guideH(width: number, height: number, size: number): Mat3 {
  const s = Math.min(width, height) * size;
  const x0 = (width - s) / 2;
  const y0 = (height - s) / 2;
  return [s / 3, 0, x0, 0, s / 3, y0, 0, 0, 1];
}

function pixelLab(img: PixelSource, p: Pt): Lab | null {
  const x = Math.round(p[0]);
  const y = Math.round(p[1]);
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
  const k = (y * img.width + x) * 4;
  return rgbToLab(img.data[k], img.data[k + 1], img.data[k + 2]);
}

// 点の周りの細かい模様の強さ（隣り合う画素の明るさの差の平均）。キューブのセルはなめらか（ステッカーも成形色も）で、
// 壁紙・木目・手のしわは細かい模様がある。白っぽい壁や手が白・オレンジのセルに見えるのを見分けるのに使う。
// カメラの雑音（暗い部屋の Web カメラなど）も模様に見えるので、しきい値はそのフレームで最もなめらかなところに合わせる
const SMOOTH = 1.6; // これ以下ならなめらか（雑音の少ない画像で）
const TEXTURED = 2.5; // これ以上なら模様がある（同）
interface TextureLevels {
  smooth: number;
  textured: number;
}
function textureLevels(img: PixelSource, r: number): TextureLevels {
  const v: number[] = [];
  for (let gy = 1; gy < 12; gy++)
    for (let gx = 1; gx < 16; gx++) {
      const t = pixelTexture(img, [(gx * img.width) / 16, (gy * img.height) / 12], r);
      if (t !== null) v.push(t);
    }
  v.sort((a, b) => a - b);
  const floor = v.length ? v[Math.floor(v.length * 0.1)] : 0;
  return { smooth: Math.max(SMOOTH, floor * 1.8), textured: Math.max(TEXTURED, floor * 2.6) };
}
// r: 調べる範囲の半径（フレームの短辺の 1/64）
const textureRadius = (fr: FrameRef) => Math.max(3, Math.round(Math.min(fr.width, fr.height) / 64));
function pixelTexture(img: PixelSource, p: Pt, r: number): number | null {
  const cx = Math.round(p[0]);
  const cy = Math.round(p[1]);
  if (cx - r < 0 || cy - r < 0 || cx + r + 1 >= img.width || cy + r + 1 >= img.height) return null;
  const { data, width } = img;
  const v = (x: number, y: number) => {
    const k = (y * width + x) * 4;
    return Math.max(data[k], data[k + 1], data[k + 2]);
  };
  let sum = 0;
  let n = 0;
  for (let y = cy - r; y <= cy + r; y++)
    for (let x = cx - r; x <= cx + r; x++) {
      const c = v(x, y);
      sum += Math.abs(c - v(x + 1, y)) + Math.abs(c - v(x, y + 1));
      n += 2;
    }
  return sum / n;
}

// 手（MediaPipe の 21 点を囲む凸包、画像座標）に覆われたセルを無効にする
function maskHands(face: DetectedFace, hands: Pt[][]): void {
  if (!hands.length) return;
  for (let cell = 0; cell < 9; cell++) {
    const x = (cell % 3) + 0.5;
    const y = Math.floor(cell / 3) + 0.5;
    const probes = [
      [x, y],
      [x - 0.3, y - 0.3],
      [x + 0.3, y - 0.3],
      [x - 0.3, y + 0.3],
      [x + 0.3, y + 0.3],
    ].map(([px, py]) => slotPoint(face, px, py));
    if (hands.some((hull) => probes.some((p) => pointInPolygon(p, hull)))) {
      face.valid[cell] = false;
      face.masked[cell] = true;
    }
  }
}

// 面全体が1色の大きな四角形を 3x3 の面とみなす（ステッカーレスの完成面を初見で拾う救済）
function uniformFaces(img: PixelSource, quads: Quad[]): LatticeFace[] {
  const out: LatticeFace[] = [];
  for (const q of quads.sort((a, b) => b.area - a.area)) {
    const [cx, cy] = q.center;
    const p = [...q.corners].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    const H = fitHomography(
      [
        [0, 0],
        [3, 0],
        [3, 3],
        [0, 3],
      ],
      p,
    );
    if (!H) continue;
    // 2x3 などのブロックを面と取り違えないよう、ほぼ正方形（正面から見た面）に限る
    const sides = p.map((a, i) => Math.hypot(p[(i + 1) % 4][0] - a[0], p[(i + 1) % 4][1] - a[1]));
    if (Math.min(...sides) / Math.max(...sides) < 0.75) continue;
    const labs = Array.from({ length: 9 }, (_, i) => pixelLab(img, applyH(H, (i % 3) + 0.5, Math.floor(i / 3) + 0.5)));
    if (labs.some((l) => !l || stickerScore(l) <= 0)) continue;
    const ref = labs[4]!;
    if (labs.some((l) => Math.hypot((l![0] - ref[0]) / 2, l![1] - ref[1], l![2] - ref[2]) > 14)) continue;
    if (out.some((f) => pointInPolygon(q.center, [applyH(f.H, 0, 0), applyH(f.H, 3, 0), applyH(f.H, 3, 3), applyH(f.H, 0, 3)]))) continue;
    out.push({ H, found: 9, cellQuad: new Array(9).fill(-1), residual: 0, pitch: Math.sqrt(q.area) / 3, alts: [] });
    if (out.length >= 3) break;
  }
  return out;
}

const chroma = (l: Lab) => Math.hypot(l[1], l[2]);

// 見つかった面（正面を含む）からキューブの姿勢を求め、見つからなかった隣の面（上・下・左・右）の格子を 3D の
// キューブから射影して足す。ステッカーレスで斜めから見た面は、セルが潰れて四角形として見つからないことが多いが、
// 正面の格子が正確なら隣の面の位置は決まる。直前の位置から運んだ面より新しいので、そちらと入れ替える。
// 読んだ色は軽く扱い（held）、ステッカーらしい色のセルが半分に満たなければ捨てる（下の読み取りで確かめる）
const PREDICT_SLOTS = [0, 1, 3, 4]; // U R D L
// 共有する辺を軸に試す角度（ラジアン）。正面だけから求めた傾きは小さめに出るので、広げる側を細かく
// 面の奥の辺の外側の点（スロットの格子座標）。U は行 0、D は行 2、R は列 2、L は列 0 の側が奥
const BEYOND: Record<number, (u: number) => [number, number]> = { 0: (u) => [u, -0.45], 3: (u) => [u, 3.45], 1: (u) => [3.45, u], 4: (u) => [-0.45, u] };
const HINGE = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, -0.1, -0.2, -0.3];
function predictNeighbours(placed: PlacedFace[], img: PixelSource, fr: FrameRef, pitch: number, refs: Lab[] | null, hands: Pt[][], minFacing: number, hinge: boolean, prev?: Record<number, number>): Record<number, number> {
  const chosen: Record<number, number> = {};
  const real = placed.filter((p) => !(p as { held?: boolean }).held);
  if (!real.some((p) => p.slot === 2)) return chosen;
  const focal = defaultFocal(fr.width, fr.height);
  const center: Pt = [fr.ox + fr.width / 2, fr.oy + fr.height / 2];
  const pose = estimatePose(real, img.width, img.height, focal, center);
  // 格子と合わない姿勢（当てはめの誤り・回転途中の層）なら予測しない
  if (!pose || pose.err > pitch * 0.15) return chosen;
  // キューブの色らしい点か（手の上・肌らしい色は分からない = null）
  const cubeLike = (p: Pt): boolean | null => {
    if (hands.some((hull) => pointInPolygon(p, hull))) return null;
    const lab = pixelLab(img, p);
    if (!lab) return false;
    const d = refs ? Math.min(...refs.map((r) => Math.hypot((lab[0] - r[0]) / 2, lab[1] - r[1], lab[2] - r[2]))) : 0;
    if (d > 12 && skinLike(lab)) return null;
    return stickerScore(lab) > 0 && d < 30;
  };
  for (const slot of PREDICT_SLOTS) {
    const i = placed.findIndex((p) => p.slot === slot);
    if (i >= 0 && !(placed[i] as { held?: boolean }).held) continue;
    // 辺を蝶番にして傾きを変え、面のセルがキューブの色で、面の向こう側（奥の辺の外）はそうでない角度を選ぶ。
    // 傾きが小さすぎると奥の辺の外もまだ面の上、大きすぎると奥の列が背景にかかる
    let best: { H: Mat3; score: number; a: number } | null = null;
    for (const a of hinge ? HINGE : [0]) {
      const pr = projectSlot(a ? hingePose(pose, slot, a) : pose, slot, img.width, img.height, focal, center);
      if (!pr || pr.facing < minFacing) continue;
      // 画面からはみ出す面は読まない
      const g = { H: pr.H, rot: 0 };
      const corners = [slotPoint(g, 0, 0), slotPoint(g, 3, 0), slotPoint(g, 3, 3), slotPoint(g, 0, 3)];
      if (corners.some(([x, y]) => x < 0 || y < 0 || x >= img.width || y >= img.height)) continue;
      let score = 0;
      for (let k = 0; k < 9; k++) {
        const v = cubeLike(slotPoint(g, (k % 3) + 0.5, Math.floor(k / 3) + 0.5));
        score += v === null ? 0 : v ? 1 : -0.5;
      }
      // 奥の辺（正面と反対側の辺）の向こう
      for (let c = 0; c < 3; c++) if (cubeLike(slotPoint(g, ...BEYOND[slot](c + 0.5)))) score--;
      // 同点なら直前のフレームの角度、なければ求めた姿勢に近い方。角度がフレームごとに揺れると、
      // 予測した面のセルが動いて見え、手の回し終わりの判定が遅れる
      score -= prev?.[slot] !== undefined ? Math.min(1, Math.abs(a - prev[slot]) * 4) : Math.abs(a) * 0.5;
      if (!best || score > best.score) best = { H: pr.H, score, a };
    }
    if (!best || (hinge && best.score < 2.5)) continue;
    chosen[slot] = best.a;
    const face = { slot, rot: 0, H: best.H, found: 0, latticeIndex: -1, held: true } as PlacedFace;
    if (i >= 0) placed[i] = face;
    else placed.push(face);
  }
  return chosen;
}

// 背景の格子模様（チェックのシャツ・キーボード・タイル）を面と取り違えないための確認。
// 本物の面は、ステッカーの間に黒い隙間があるか（ステッカーのあるキューブ）、色の違うセルがある。
// 代表色が分かっていれば、セルの色がキューブの 6 色に近いことも確かめる
interface FaceJudgement {
  strong: boolean; // キューブの面らしい
  weak: boolean; // 一様な面（ステッカーレスの揃った面か、背景の模様）
  centralBig: boolean;
}

function judgeFace(img: PixelSource, fr: FrameRef, f: LatticeFace, refs: Lab[] | null, tl: TextureLevels): FaceJudgement {
  const cells = Array.from({ length: 9 }, (_, k) => pixelLab(img, applyH(f.H, (k % 3) + 0.5, Math.floor(k / 3) + 0.5)));
  // 隣り合うセルの境界（12 か所）を横切る短い線分で一番暗いところが、両側のセルより十分暗いか
  let dark = 0;
  let total = 0;
  const across = (x0: number, y0: number, dx: number, dy: number, a: Lab | null, b: Lab | null) => {
    if (!a || !b) return;
    let minL = Infinity;
    for (let t = -0.15; t <= 0.151; t += 0.05) {
      const lab = pixelLab(img, applyH(f.H, x0 + dx * t, y0 + dy * t));
      if (lab) minL = Math.min(minL, lab[0]);
    }
    total++;
    if (minL < Math.min(a[0], b[0]) * 0.6 && minL < 50) dark++;
  };
  for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) across(c + 1, r + 0.5, 1, 0, cells[r * 3 + c], cells[r * 3 + c + 1]);
  for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) across(c + 0.5, r + 1, 0, 1, cells[r * 3 + c], cells[(r + 1) * 3 + c]);
  const colorful = cells.filter((l) => l && chroma(l) > 22).length;
  const bright = cells.filter((l) => l && l[0] > 62).length;
  // 色の違うセルがあるか（揃った面なら 1 色だが、ステッカーのあるキューブなら隙間で分かる）
  const known = cells.filter((l): l is Lab => !!l);
  let diverse = 0;
  for (let i = 0; i < known.length; i++)
    for (let j = i + 1; j < known.length; j++) diverse = Math.max(diverse, Math.hypot((known[i][0] - known[j][0]) / 2, known[i][1] - known[j][1], known[i][2] - known[j][2]));
  let refOk = true;
  if (refs) {
    const match = cells.filter((l) => l && Math.min(...refs.map((r) => Math.hypot((l[0] - r[0]) / 2, l[1] - r[1], l[2] - r[2]))) < 38).length;
    refOk = match >= 5;
  }
  // セルの半分以上に細かい模様がある格子は、壁・木目・手に当てたもの（指で数セル隠れた面は残す）
  const textured = Array.from({ length: 9 }, (_, k) => pixelTexture(img, applyH(f.H, (k % 3) + 0.5, Math.floor(k / 3) + 0.5), textureRadius(fr))).filter((x) => x !== null && x > tl.textured).length;
  if (textured >= 5) refOk = false;
  const strong = refOk && ((total > 0 && dark >= total * 0.5) || (colorful >= 2 && diverse > 28));
  // 一様な面（ステッカーレスの揃った面など。チェックのシャツも一様に見える）は、他に本物の面があるか、大きく画面の中央にあるときだけ
  const c = applyH(f.H, 1.5, 1.5);
  const central = Math.abs(c[0] - fr.ox - fr.width / 2) < fr.width * 0.3 && Math.abs(c[1] - fr.oy - fr.height / 2) < fr.height * 0.35;
  const big = faceArea(f.H) > (fr.width * fr.height) / 40;
  const weak = refOk && !strong && (bright >= 7 || colorful >= 7);
  (globalThis as { __cvDebug?: (m: unknown) => void }).__cvDebug?.({ dark, total, colorful, diverse: Math.round(diverse), bright, refOk, strong, weak, central, big });
  return { strong, weak, centralBig: central && big };
}

// strong: 先頭からいくつがキューブの面らしい（色の違うセル・黒い隙間がある）ものか。残りは一様な面
function findCubeFaces(img: PixelSource, fr: FrameRef, quads: Quad[], config: PipelineConfig, scorer: (p: Pt) => number, faceScorer: (H: Mat3) => number, refs: Lab[] | null, tl: TextureLevels): LatticeFace[] & { strong?: number } {
  // 面の数に数えるのはキューブの面らしいものだけ。一様な格子は脇に置き、本物の面が見つかったか、
  // 大きく中央にあるときだけ足す（チェックのシャツの格子がいくつあっても、キューブの面の探索を邪魔しない）
  const aside: { f: LatticeFace; j: FaceJudgement }[] = [];
  const faces = findFaces(quads, config.lattice, scorer, faceScorer, (f) => {
    const j = judgeFace(img, fr, f, refs, tl);
    if (!j.strong && j.weak) aside.push({ f, j });
    return j.strong;
  });
  const extra = aside.filter((a) => faces.length > 0 || a.j.centralBig).map((a) => a.f);
  const out = [...faces, ...extra].slice(0, Math.max(faces.length, config.lattice.maxFaces ?? 3));
  return Object.assign(out, { strong: faces.length });
}

export function processFrame(
  cv: CV | null,
  img: PixelSource & { mat?: unknown },
  t: number,
  config: PipelineConfig,
  memory: { last: PipelineMemory | null },
  refs: Lab[] | null,
  hands: Pt[][] = [],
): FrameResult {
  if (config.stickers && config.stickers !== "color" && cv)
    return processAruco(cv, img, t, memory, stickerScheme(config.stickers), !!config.arucoThorough, { reread: config.arucoReread, focus: config.focus, colorFill: config.arucoColorFill, idTrack: config.arucoIdTrack, region: config.arucoRegion });
  let placed: PlacedFace[] = [];
  let quadsOut: Pt[][] = [];
  if (config.mode === "guide" || !cv) {
    placed = [{ slot: 2, rot: 0, H: guideH(img.width, img.height, config.guideSize), found: 9, latticeIndex: 0 }];
  } else {
    const fr: FrameRef = config.frame ?? { width: img.width, height: img.height, ox: 0, oy: 0 };
    const quadOpts = { ...config.quads, refSize: { cols: fr.width, rows: fr.height } };
    // 溝の候補でやり直すときは、エッジ・明るさ・溝の強さの画像を使い回す（QuadFinder。この下のやり直しが終わったら捨てる）
    const mat = cv.matFromImageData(img);
    let finder: QuadFinder;
    try {
      finder = new QuadFinder(cv, mat, quadOpts);
    } finally {
      mat.delete();
    }
    let quads = finder.quads();
    quadsOut = quads.map((q) => q.corners);
    const tr = textureRadius(fr);
    const tl = textureLevels(img, tr);
    const scorer = (p: Pt) => {
      const lab = pixelLab(img, p);
      if (!lab) return -1;
      const s = stickerScore(lab);
      if (s <= 0) return s;
      // 色はステッカーらしくても、細かい模様があれば壁・木目・手
      const tex = pixelTexture(img, p, tr);
      return tex === null || tex < tl.smooth ? s : tex > tl.textured ? -0.4 : 0.1;
    };
    // 直前のフレームで見えていた面（ステッカーレスのブロック分割と、窓の位置の曖昧さの解消に使う）
    const prevFaces = memory.last && t - memory.last.t < 600 ? memory.last.faces : [];
    const faceScorer = (H: Mat3) => {
      const c = applyH(H, 1.5, 1.5);
      const pitch = memory.last?.pitch ?? 0;
      return prevFaces.some((f) => {
        const p = applyH(f.H, 1.5, 1.5);
        return Math.hypot(p[0] - c[0], p[1] - c[1]) < pitch * 0.5;
      })
        ? // 直前のフレームの面の位置を強く優先する（指で 1 段隠れたとき、隣の面の段へ窓がずれないように。
          // 1 フレームの間にキューブが 1 段分動くことはまずない）
          8
        : 0;
    };
    let faces: LatticeFace[] & { strong?: number };
    try {
      faces = findCubeFaces(img, fr, expandBlocks(quads, prevFaces.map((f) => f.H)), config, scorer, faceScorer, refs, tl);
      if (!faces.length && config.grooveRetry) {
        // 面が見つからない: ステッカーレスで同じ色がつながっている・丸いセルが溶け合って見えるとき。ピースの間の溝で
        // セルを区切った候補も加えてやり直す（見つかるフレームでは使わない。溝の候補は他の候補と混ざると格子を乱すことがある）
        // 溝の濃さは照明やキューブの大きさで変わるので、はっきりした溝 → 薄い溝の順に試す
        for (const th of [config.quads.grooveThreshold, config.quads.grooveThreshold * 0.6]) {
          quads = finder.withGrooves(th);
          quadsOut = quads.map((q) => q.corners);
          faces = findCubeFaces(img, fr, expandBlocks(quads, prevFaces.map((f) => f.H)), config, scorer, faceScorer, refs, tl);
          if (faces.length) break;
        }
      }
    } finally {
      finder.delete();
    }
    if (!faces.length) faces = uniformFaces(img, largeFaceCandidates(quads, fr.width * fr.height));
    if (faces.length) {
      // 前のフレームと同じ中心色の面をアンカーに（角から見たときに正面が入れ替わらないように）
      const keyOf = (H: Mat3) => {
        const lab = pixelLab(img, applyH(H, 1.5, 1.5));
        if (!lab) return -1;
        if (refs) {
          let best = 0;
          let bestD = Infinity;
          refs.forEach((r, i) => {
            const d = Math.hypot((lab[0] - r[0]) / 2, lab[1] - r[1], lab[2] - r[2]);
            if (d < bestD) (bestD = d), (best = i);
          });
          return best;
        }
        return nearestNamed(lab);
      };
      const recent = memory.last && t - memory.last.t < 600 ? memory.last : null;
      // 直前の正面が見つからず、見つかった面がどれも直前の上・横の面の位置にほぼ止まっている（指で正面が隠れた）なら、
      // その面を正面に格上げしない。格上げすると、上の面の色を正面の色として読み、ありもしない手に見える。
      // このフレームは読まずに飛ばす。キューブを回して別の面を見せているとき（スキャン・持ち替え）は面が動くので
      // 当てはまらない。止まったまま正面が見えない状態が続いたら（SKIP_MS）、普通に選び直す
      if (recent && t - recent.t < SKIP_MS) {
        const prevA = recent.faces.find((f) => f.slot === 2 && !(f as { held?: boolean }).held);
        const dist = (H: Mat3, G: Mat3) => {
          const a = applyH(H, 1.5, 1.5);
          const b = applyH(G, 1.5, 1.5);
          return Math.hypot(a[0] - b[0], a[1] - b[1]);
        };
        const anchorSeen = prevA && faces.some((f) => dist(f.H, prevA.H) < recent.pitch * 1.2);
        const onlyOthers = faces.every((f) => recent.faces.some((p) => p.slot !== 2 && dist(f.H, p.H) < recent.pitch * 0.4));
        if (prevA && !anchorSeen && onlyOthers) return { faces: [], quads: quadsOut };
      }
      // 既定の正面は、キューブの面らしいもの（strong）のうち最も大きい面。一様な面（背景の白い箱・壁に当てた格子のこともある）を
      // 正面にすると、本物の面が「辺を共有しない」として捨てられる
      let anchor: number | undefined =
        faces.strong && faces.strong < faces.length ? faces.slice(0, faces.strong).reduce((bi, f, i, arr) => (faceArea(f.H) > faceArea(arr[bi].H) ? i : bi), 0) : undefined;
      if (recent) {
        const same = faces.map((f, i) => ({ i, k: keyOf(f.H), a: faceArea(f.H) })).filter((x) => x.k === recent.centerKey);
        // 前のアンカーの面が、他よりそれほど小さくなっていなければ維持
        const largest = Math.max(...faces.map((f) => faceArea(f.H)));
        if (same.length && same[0].a > largest * 0.45) anchor = same[0].i;
      }
      placed = layoutFaces(faces, { anchor, anchorAngle: recent && t - recent.t < 300 ? recent.angle : undefined });
      // 窓の位置が曖昧な面は、ずらした格子も読みの候補にする（指で 1 段隠れた面と、隣の面の段を取り違えない）
      for (const p of config.altReadings ? placed : []) {
        const g = faces[p.latticeIndex];
        if (!g?.alts.length) continue;
        const alt = [g.H, ...g.alts].filter((h) => h !== p.H).slice(0, MAX_ALTS);
        if (alt.length) p.altH = alt;
      }
      const a = placed[0];
      const key = keyOf(a.H);
      // 今回見つからなかった面は、正面の動きに合わせて直前の位置から運ぶ
      // （ステッカーレスで同色がつながった面など。一様な領域なら多少ずれても読む色は同じ）
      const real: KeptFace[] = placed.map((p) => ({ ...p, seenT: t }));
      const kept = [...real];
      const prevA = recent?.faces.find((f) => f.slot === 2);
      const pc = prevA && applyH(prevA.H, 1.5, 1.5);
      const cc = applyH(a.H, 1.5, 1.5);
      // 同じ面が正面のまま、ほぼ動いていないときだけ運ぶ（正面の当てはめがずれたフレームで他の面を引きずらない）
      const sameAnchor = !!recent && !!pc && Math.hypot(pc[0] - cc[0], pc[1] - cc[1]) < recent.pitch * 0.5;
      if (recent && sameAnchor && t - recent.t < HOLD_MS) {
        // 正面の中心の移動量だけ平行移動する（射影変換ごと移すと、正面の当てはめの誤差が外側で増幅される）
        const transfer: Mat3 = [1, 0, cc[0] - pc![0], 0, 1, cc[1] - pc![1], 0, 0, 1];
        for (const f of recent.faces) {
          if (placed.some((p) => p.slot === f.slot) || t - f.seenT > CARRY_MS) continue;
          const moved: KeptFace = { ...f, H: mulH(transfer, f.H) };
          kept.push(moved);
          placed.push({ ...moved, held: true } as PlacedFace);
        }
      }
      const prevHinge = memory.last && t - memory.last.t < HOLD_MS ? memory.last.hinge : undefined;
      memory.last = { t, angle: colAngle(a), centerKey: key, pitch: faces[a.latticeIndex].pitch, faces: kept };
      if (config.predictFaces) memory.last.hinge = predictNeighbours(placed, img, fr, faces[a.latticeIndex].pitch, refs, hands, config.minFacing, config.hingeSearch, prevHinge);
    } else if (memory.last && t - memory.last.t < HOLD_MS && memory.last.faces.length) {
      // 何も見つからない: ごく短時間だけ直前の面を使う（下で色がステッカーらしいか確かめる）
      placed = memory.last.faces.map((f) => ({ ...f, held: true }) as PlacedFace);
    }
  }

  const out: DetectedFace[] = [];
  for (const p of placed) {
    const held = !!(p as { held?: boolean }).held;
    const samples = sampleFace(img, p, config.region);
    // 保持した面は、半分以上のセルがステッカーらしい色のときだけ使う（キューブが画面外に出たら捨てる）。
    // 指などで隠れてステッカーらしくないセルは読まない
    if (held) {
      const ok = samples.map((s) => s.valid && stickerScore(s.lab) > 0);
      if (ok.filter(Boolean).length < 5) continue;
      samples.forEach((s, i) => (s.valid = ok[i]));
    }
    const face: DetectedFace = {
      slot: p.slot,
      rot: p.rot,
      held,
      H: p.H,
      found: p.found,
      labs: samples.map((s) => s.lab),
      spread: samples.map((s) => s.spread),
      valid: samples.map((s) => s.valid && s.spread < config.maxSpread),
      // 回転途中の層のステッカーは格子に合わず四角形が見つからないので、推定した位置の色は軽く扱う
      // 白く飛んだセル（強い映り込み）は、白・黄・映り込みの区別がつかないので軽く扱う
      weight: Array.from({ length: 9 }, (_, i) => (held ? 0.6 : config.mode === "guide" || !p.support || p.support[i] ? 1 : 0.6) * (samples[i].clip > 0.5 ? 0.35 : 1)),
      masked: new Array(9).fill(false),
    };
    maskHands(face, hands);
    if (p.altH && !held) {
      face.alts = p.altH.map((H) => {
        const ss = sampleFace(img, { H, rot: p.rot }, config.region);
        const a: DetectedFace = { ...face, H, labs: ss.map((x) => x.lab), valid: ss.map((x) => x.valid && x.spread < config.maxSpread), masked: new Array(9).fill(false) };
        maskHands(a, hands);
        return { labs: a.labs, valid: a.valid };
      });
    }
    out.push(face);
  }
  if (out.length && out[0].slot !== 2) return { faces: [], quads: quadsOut };
  return { faces: out, quads: quadsOut };
}

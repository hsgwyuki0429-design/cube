// 1フレームの処理: ステッカー検出 → 面の格子 → カメラフレームへの配置 → 色サンプリング → 手のマスク。
// Worker とテストの両方から使う（OpenCV のオブジェクトは呼び出し側が渡す）。
import { type Lab, nearestNamed } from "./color";
import { type Mat3, type Pt, applyH, fitHomography, mulH } from "./homography";
import { expandBlocks, largeFaceCandidates } from "./blocks";
import { type LatticeFace, type LatticeOptions, type Quad, findFaces } from "./lattice";
import { type PlacedFace, colAngle, faceArea, layoutFaces, slotPoint } from "./layout";
import { type CV, type QuadOptions, DEFAULT_QUADS, findQuads } from "./quads";
import { type PixelSource, sampleFace } from "./sampler";
import { stickerScore } from "./stickerness";
import { rgbToLab } from "./color";
import { pointInPolygon } from "./lattice";

export interface PipelineConfig {
  mode: "auto" | "guide";
  guideSize: number; // ガイド枠モード: 短辺に対する枠の大きさ
  region: number; // セル内のサンプリング範囲
  maxSpread: number; // セル内のばらつきがこれ以上なら読まない
  quads: QuadOptions;
  lattice: Partial<LatticeOptions>;
}

export const DEFAULT_PIPELINE: PipelineConfig = {
  mode: "auto",
  guideSize: 0.6,
  region: 0.6,
  maxSpread: 60,
  quads: DEFAULT_QUADS,
  lattice: {},
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
}

type KeptFace = PlacedFace & { seenT: number }; // seenT: 最後に実際に検出できた時刻

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

// 背景の格子模様（チェックのシャツ・キーボード・タイル）を面と取り違えないための確認。
// 本物の面は、ステッカーの間に黒い隙間があるか（ステッカーのあるキューブ）、色の違うセルがある。
// 代表色が分かっていれば、セルの色がキューブの 6 色に近いことも確かめる
interface FaceJudgement {
  strong: boolean; // キューブの面らしい
  weak: boolean; // 一様な面（ステッカーレスの揃った面か、背景の模様）
  centralBig: boolean;
}

function judgeFace(img: PixelSource, f: LatticeFace, refs: Lab[] | null): FaceJudgement {
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
  const strong = refOk && ((total > 0 && dark >= total * 0.5) || (colorful >= 2 && diverse > 28));
  // 一様な面（ステッカーレスの揃った面など。チェックのシャツも一様に見える）は、他に本物の面があるか、大きく画面の中央にあるときだけ
  const c = applyH(f.H, 1.5, 1.5);
  const central = Math.abs(c[0] - img.width / 2) < img.width * 0.3 && Math.abs(c[1] - img.height / 2) < img.height * 0.35;
  const big = faceArea(f.H) > (img.width * img.height) / 40;
  const weak = refOk && !strong && (bright >= 7 || colorful >= 7);
  (globalThis as { __cvDebug?: (m: unknown) => void }).__cvDebug?.({ dark, total, colorful, diverse: Math.round(diverse), bright, refOk, strong, weak, central, big });
  return { strong, weak, centralBig: central && big };
}

function findCubeFaces(img: PixelSource, quads: Quad[], config: PipelineConfig, scorer: (p: Pt) => number, faceScorer: (H: Mat3) => number, refs: Lab[] | null): LatticeFace[] {
  // 面の数に数えるのはキューブの面らしいものだけ。一様な格子は脇に置き、本物の面が見つかったか、
  // 大きく中央にあるときだけ足す（チェックのシャツの格子がいくつあっても、キューブの面の探索を邪魔しない）
  const aside: { f: LatticeFace; j: FaceJudgement }[] = [];
  const faces = findFaces(quads, config.lattice, scorer, faceScorer, (f) => {
    const j = judgeFace(img, f, refs);
    if (!j.strong && j.weak) aside.push({ f, j });
    return j.strong;
  });
  const extra = aside.filter((a) => faces.length > 0 || a.j.centralBig).map((a) => a.f);
  return [...faces, ...extra].slice(0, Math.max(faces.length, config.lattice.maxFaces ?? 3));
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
  let placed: PlacedFace[] = [];
  let quadsOut: Pt[][] = [];
  if (config.mode === "guide" || !cv) {
    placed = [{ slot: 2, rot: 0, H: guideH(img.width, img.height, config.guideSize), found: 9, latticeIndex: 0 }];
  } else {
    const mat = cv.matFromImageData(img);
    let quads;
    try {
      quads = findQuads(cv, mat, config.quads);
    } finally {
      mat.delete();
    }
    quadsOut = quads.map((q) => q.corners);
    const scorer = (p: Pt) => {
      const lab = pixelLab(img, p);
      return lab ? stickerScore(lab) : -1;
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
        ? 4
        : 0;
    };
    let faces = findCubeFaces(img, expandBlocks(quads, prevFaces.map((f) => f.H)), config, scorer, faceScorer, refs);
    if (!faces.length) faces = uniformFaces(img, largeFaceCandidates(quads, img.width * img.height));
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
      let anchor: number | undefined;
      if (recent) {
        const same = faces.map((f, i) => ({ i, k: keyOf(f.H), a: faceArea(f.H) })).filter((x) => x.k === recent.centerKey);
        // 前のアンカーの面が、他よりそれほど小さくなっていなければ維持
        const largest = Math.max(...faces.map((f) => faceArea(f.H)));
        if (same.length && same[0].a > largest * 0.45) anchor = same[0].i;
      }
      placed = layoutFaces(faces, { anchor, anchorAngle: recent && t - recent.t < 300 ? recent.angle : undefined });
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
      memory.last = { t, angle: colAngle(a), centerKey: key, pitch: faces[a.latticeIndex].pitch, faces: kept };
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
      weight: Array.from({ length: 9 }, (_, i) => (held ? 0.6 : config.mode === "guide" || !p.support || p.support[i] ? 1 : 0.6)),
      masked: new Array(9).fill(false),
    };
    maskHands(face, hands);
    out.push(face);
  }
  if (out.length && out[0].slot !== 2) return { faces: [], quads: quadsOut };
  return { faces: out, quads: quadsOut };
}

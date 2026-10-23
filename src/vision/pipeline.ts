// 1フレームの処理: ステッカー検出 → 面の格子 → カメラフレームへの配置 → 色サンプリング → 手のマスク。
// Worker とテストの両方から使う（OpenCV のオブジェクトは呼び出し側が渡す）。
import { type Lab, nearestNamed } from "./color";
import { type Mat3, type Pt, applyH } from "./homography";
import { type LatticeOptions, findFaces } from "./lattice";
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
  region: 0.5,
  maxSpread: 60,
  quads: DEFAULT_QUADS,
  lattice: {},
};

export interface DetectedFace {
  slot: number;
  rot: number;
  H: Mat3;
  found: number;
  labs: Lab[];
  spread: number[];
  valid: boolean[];
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
}

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
    if (hands.some((hull) => probes.some((p) => pointInPolygon(p, hull)))) face.valid[cell] = false;
  }
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
    const faces = findFaces(quads, config.lattice, scorer);
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
      placed = layoutFaces(faces, { anchor, anchorAngle: recent && t - recent.t < 300 ? recent.angle : 0 });
      const a = placed[0];
      memory.last = { t, angle: colAngle(a), centerKey: keyOf(a.H) };
    }
  }

  const out: DetectedFace[] = placed.map((p) => {
    const samples = sampleFace(img, p, config.region);
    const face: DetectedFace = {
      slot: p.slot,
      rot: p.rot,
      H: p.H,
      found: p.found,
      labs: samples.map((s) => s.lab),
      spread: samples.map((s) => s.spread),
      valid: samples.map((s) => s.valid && s.spread < config.maxSpread),
    };
    maskHands(face, hands);
    return face;
  });
  return { faces: out, quads: quadsOut };
}

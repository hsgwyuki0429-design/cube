/**
 * ピラミッド型 Lucas–Kanade オプティカルフロー。
 *
 * 純粋関数。画像は Uint8 のグレースケールバッファとして受け取るので Node でテストできる。
 *
 * なぜ OpenCV.js ではなく自前かは docs/cube-tracking.md 参照。要点は
 * 「必要なのは LK + ホモグラフィ推定だけで、数MBの wasm を初回ロードに載せる価値がない」。
 */

export interface GrayImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export function createGray(width: number, height: number): GrayImage {
  return { data: new Uint8Array(width * height), width, height };
}

/** RGBA (ImageData.data) -> グレースケール。ITU-R BT.601 の輝度。 */
export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, out?: GrayImage): GrayImage {
  const img = out && out.width === width && out.height === height ? out : createGray(width, height);
  const d = img.data;
  for (let i = 0, p = 0; i < d.length; i++, p += 4) {
    d[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return img;
}

/** 2x2 平均で半分に縮小する。 */
export function downsample(src: GrayImage): GrayImage {
  const w = Math.max(1, src.width >> 1);
  const h = Math.max(1, src.height >> 1);
  const out = createGray(w, h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.min(src.height - 1, y * 2);
    const y1 = Math.min(src.height - 1, y * 2 + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.min(src.width - 1, x * 2);
      const x1 = Math.min(src.width - 1, x * 2 + 1);
      out.data[y * w + x] =
        (src.data[y0 * src.width + x0] + src.data[y0 * src.width + x1] +
         src.data[y1 * src.width + x0] + src.data[y1 * src.width + x1] + 2) >> 2;
    }
  }
  return out;
}

export type Pyramid = GrayImage[];

/** レベル0が原寸。levels は総段数。 */
export function buildPyramid(img: GrayImage, levels = 3): Pyramid {
  const out: Pyramid = [img];
  for (let i = 1; i < levels; i++) {
    const prev = out[i - 1];
    if (prev.width < 24 || prev.height < 24) break;
    out.push(downsample(prev));
  }
  return out;
}

/** バイリニア補間。範囲外はクランプ。 */
export function sampleBilinear(img: GrayImage, x: number, y: number): number {
  const w = img.width;
  const h = img.height;
  let x0 = Math.floor(x);
  let y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  let x1 = x0 + 1;
  let y1 = y0 + 1;
  if (x0 < 0) x0 = 0; else if (x0 > w - 1) x0 = w - 1;
  if (x1 < 0) x1 = 0; else if (x1 > w - 1) x1 = w - 1;
  if (y0 < 0) y0 = 0; else if (y0 > h - 1) y0 = h - 1;
  if (y1 < 0) y1 = 0; else if (y1 > h - 1) y1 = h - 1;
  const d = img.data;
  const a = d[y0 * w + x0];
  const b = d[y0 * w + x1];
  const c = d[y1 * w + x0];
  const e = d[y1 * w + x1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + e) * fx * fy;
}

export interface FlowOptions {
  /** 窓の半径。窓は (2r+1)^2 */
  windowRadius: number;
  levels: number;
  maxIterations: number;
  /** 反復の収束判定（px） */
  epsilon: number;
  /** G 行列の最小固有値（窓画素数で正規化）の下限。テクスチャの無い点を捨てる */
  minEigenvalue: number;
  /** 追跡後の平均輝度残差の上限（0..255） */
  maxResidual: number;
}

export function defaultFlowOptions(): FlowOptions {
  return {
    windowRadius: 6,
    levels: 3,
    maxIterations: 12,
    epsilon: 0.02,
    minEigenvalue: 1.2,
    maxResidual: 26,
  };
}

export interface FlowResult {
  x: number;
  y: number;
  ok: boolean;
  /** 平均輝度残差。小さいほど良い */
  residual: number;
  /** G の最小固有値（正規化済み）。テクスチャの豊かさ */
  eigen: number;
}

/**
 * prev の点 (px, py) が next のどこへ移ったかを求める。
 * guess は初期推定（前フレームの速度など）。無ければ 0。
 */
function trackOne(
  prevPyr: Pyramid,
  nextPyr: Pyramid,
  px: number,
  py: number,
  guessX: number,
  guessY: number,
  o: FlowOptions,
): FlowResult {
  const levels = Math.min(prevPyr.length, nextPyr.length);
  const r = o.windowRadius;
  const side = 2 * r + 1;
  const n = side * side;
  const Ix = new Float32Array(n);
  const Iy = new Float32Array(n);
  const Ip = new Float32Array(n);

  let gx = guessX / (1 << (levels - 1));
  let gy = guessY / (1 << (levels - 1));
  let residual = Infinity;
  let eigen = 0;
  let failed = false;

  for (let L = levels - 1; L >= 0; L--) {
    const prev = prevPyr[L];
    const next = nextPyr[L];
    const scale = 1 / (1 << L);
    const cx = px * scale;
    const cy = py * scale;

    if (cx < -r || cy < -r || cx > prev.width + r || cy > prev.height + r) {
      failed = true;
      break;
    }

    // prev 側の勾配とパッチは反復中不変なので先に作る
    let a = 0;
    let b = 0;
    let c = 0;
    for (let dy = -r, k = 0; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++, k++) {
        const sx = cx + dx;
        const sy = cy + dy;
        const ix = (sampleBilinear(prev, sx + 1, sy) - sampleBilinear(prev, sx - 1, sy)) * 0.5;
        const iy = (sampleBilinear(prev, sx, sy + 1) - sampleBilinear(prev, sx, sy - 1)) * 0.5;
        Ix[k] = ix;
        Iy[k] = iy;
        Ip[k] = sampleBilinear(prev, sx, sy);
        a += ix * ix;
        b += ix * iy;
        c += iy * iy;
      }
    }
    const tr = a + c;
    const minEig = (tr - Math.sqrt((a - c) * (a - c) + 4 * b * b)) / 2 / n;
    if (L === 0) eigen = minEig;
    const det = a * c - b * b;
    if (minEig < o.minEigenvalue * 0.25 || Math.abs(det) < 1e-6) {
      // このレベルでは解けない。上位レベルの推定をそのまま下ろす
      if (L > 0) {
        gx *= 2;
        gy *= 2;
        continue;
      }
      failed = true;
      break;
    }

    for (let iter = 0; iter < o.maxIterations; iter++) {
      let bx = 0;
      let by = 0;
      let absSum = 0;
      for (let dy = -r, k = 0; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++, k++) {
          const it = Ip[k] - sampleBilinear(next, cx + gx + dx, cy + gy + dy);
          bx += it * Ix[k];
          by += it * Iy[k];
          absSum += it < 0 ? -it : it;
        }
      }
      residual = absSum / n;
      const dxs = (c * bx - b * by) / det;
      const dys = (a * by - b * bx) / det;
      if (!Number.isFinite(dxs) || !Number.isFinite(dys)) {
        failed = true;
        break;
      }
      gx += dxs;
      gy += dys;
      if (Math.hypot(dxs, dys) < o.epsilon) break;
    }
    if (failed) break;
    if (L > 0) {
      gx *= 2;
      gy *= 2;
    }
  }

  const x = px + gx;
  const y = py + gy;
  const img = nextPyr[0];
  const inside = x >= -r && y >= -r && x <= img.width + r && y <= img.height + r;
  const ok = !failed && inside && Number.isFinite(x) && Number.isFinite(y) &&
    residual <= o.maxResidual && eigen >= o.minEigenvalue;
  return { x, y, ok, residual, eigen };
}

/**
 * 複数点をまとめて追跡する。points は [x0,y0,x1,y1,...]。
 * guesses があれば初期推定として使う（同じ並び）。
 */
export function trackPoints(
  prevPyr: Pyramid,
  nextPyr: Pyramid,
  points: ArrayLike<number>,
  o: FlowOptions = defaultFlowOptions(),
  guesses?: ArrayLike<number>,
): FlowResult[] {
  const out: FlowResult[] = [];
  for (let i = 0; i * 2 < points.length; i++) {
    out.push(trackOne(
      prevPyr, nextPyr,
      points[i * 2], points[i * 2 + 1],
      guesses ? guesses[i * 2] : 0,
      guesses ? guesses[i * 2 + 1] : 0,
      o,
    ));
  }
  return out;
}

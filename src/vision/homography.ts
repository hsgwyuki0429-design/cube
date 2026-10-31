// 射影変換（ホモグラフィ）。点対応からの最小二乗推定（正規化 DLT）と適用。
export type Pt = [number, number];
export type Mat3 = number[]; // 行優先 9 要素

export function applyH(H: Mat3, x: number, y: number): Pt {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function invertH(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const inv = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d];
  return inv.map((v) => v / det);
}

export function mulH(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) out[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return out;
}

// 対称行列の最小固有値に対応する固有ベクトル（ヤコビ法）
function smallestEigenvector(M: number[][]): number[] {
  const n = M.length;
  const A = M.map((r) => [...r]);
  const V: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
    if (off < 1e-18) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-30) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p];
          const akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k];
          const aqk = A[q][k];
          A[p][k] = c * apk - s * aqk;
          A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p];
          const vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let min = 0;
  for (let i = 1; i < n; i++) if (A[i][i] < A[min][min]) min = i;
  return V.map((r) => r[min]);
}

// |A h| を h の 9 番目 = 1 として最小にする（8 元の正規方程式をガウスの消去法で解く）。正規化した座標では 9 番目が 0 に近くなる
// ことはまずないので、ヤコビ法で最小固有ベクトルを求めるより 1 桁速い（1 フレームに数百回呼ぶ）。解けなければ null（ヤコビ法に任せる）
function solveNormalized(AtA: number[][]): number[] | null {
  const n = 8;
  const M = Array.from({ length: n }, (_, r) => [...AtA[r].slice(0, n), -AtA[r][8]]);
  let scale = 0;
  for (let r = 0; r < n; r++) scale = Math.max(scale, Math.abs(M[r][r]));
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-10 * (scale || 1)) return null;
    if (piv !== c) [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / d;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const h = new Array(9).fill(0);
  h[8] = 1;
  for (let r = n - 1; r >= 0; r--) {
    let v = M[r][n];
    for (let k = r + 1; k < n; k++) v -= M[r][k] * h[k];
    h[r] = v / M[r][r];
  }
  return h;
}

function normalizer(pts: Pt[]): { T: Mat3; apply: (p: Pt) => Pt } {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const d = pts.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / pts.length || 1;
  const k = Math.SQRT2 / d;
  return { T: [k, 0, -k * cx, 0, k, -k * cy, 0, 0, 1], apply: (p) => [(p[0] - cx) * k, (p[1] - cy) * k] };
}

// src[i] → dst[i] の射影変換。weights で点ごとの重み（省略時 1）。
export function fitHomography(src: Pt[], dst: Pt[], weights?: number[]): Mat3 | null {
  if (src.length < 4) return null;
  const ns = normalizer(src);
  const nd = normalizer(dst);
  const AtA = Array.from({ length: 9 }, () => new Array(9).fill(0));
  src.forEach((s0, i) => {
    const [x, y] = ns.apply(s0);
    const [u, v] = nd.apply(dst[i]);
    const w = weights?.[i] ?? 1;
    const rows = [
      [-x, -y, -1, 0, 0, 0, u * x, u * y, u],
      [0, 0, 0, -x, -y, -1, v * x, v * y, v],
    ];
    for (const r of rows) for (let a = 0; a < 9; a++) for (let b = 0; b < 9; b++) AtA[a][b] += w * r[a] * r[b];
  });
  const h = solveNormalized(AtA) ?? smallestEigenvector(AtA);
  if (h.some((v) => !Number.isFinite(v))) return null;
  // H = Td⁻¹ · Hn · Ts
  const H = mulH(mulH(invertH(nd.T), h), ns.T);
  const s = H[8];
  if (Math.abs(s) < 1e-12) return null;
  return H.map((v) => v / s);
}

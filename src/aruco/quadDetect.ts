// 色付き ArUco マーカー（3×3 の符号・黒い枠）の専用の検出。OpenCV を使わない（DOM もカメラも知らない。Node でも動く）。
//
// OpenCV の ArucoDetector は、二値化の窓ごとに輪郭を全部たどって四角形に近似し、候補を 1 つずつ射影変換で切り出して大津の二値化で
// 読む。キューブの上は候補だらけ（ステッカー 1 枚にマーカー 4 個・見えている面に 100 個以上）なので、時間は画素の数よりも候補の
// 処理で決まっていた（実物の動画で、キューブの周りだけ切り出しても 10ms・画像全体で 15ms）。ここでは:
//   1. 明るさ max(R, G, B) を窓ごとに二値化する（まわりの平均より C 以上暗い。窓の中の和は足し引きでずらして作る）
//   2. 暗い画素を行ごとの連なり（ラン）にして、連結成分をまとめる（輪郭はたどらない）。成分ごとに 8 方向の端の点だけ覚える
//   3. 大きさの合う成分の端の点から四隅を決め、マスの中心の明暗を直接読んで符号を照らす（切り出さない）
// 角の座標の決め方（成分の縁の画素の中心）は OpenCV の輪郭と同じなので、後段（面の組み立て・手の時刻）はそのまま使える
import { type Pt, cornerPoints } from "../vision/homography";
import { THRESH_WASM } from "./threshWasm";
import { type StickerScheme, codesOf, markerBits } from "./codes";
import { type DetectResult, type ImageLike, type Marker, type MarkerDetector, type Region, halveRegionInto, measureCells } from "./detect";

export interface QuadOptions {
  windows: number[]; // 二値化の窓（画素。奇数）
  c: number; // まわりの平均よりこれだけ暗ければ「暗い」
  minSide: number; // マーカーの辺の下限（画素）
  maxSide: number; // 上限
  minFit: number; // マスの中心付近の明暗が符号どおりの割合の下限（src/aruco/detect.ts の MIN_FIT と同じ）
  borderErrors: number; // 枠のマス（16 個）のうち明るく読めてもよい数
  sibling?: number; // 同じステッカーの隣のマーカーまでの間隔（マーカーの辺を 1 として。既定 1.25 = quad-half の 0.5 / 0.4）
  weakFit?: number; // 枠が欠けて読めたマーカーでも、符号どおりの割合がこれ以上なら隣に同じ ID がなくても使う
  refineTol?: number;
  refine?: boolean; // 辺を明暗の境目に合わせ直して角を出す（既定: する）
  forceJs?: boolean; // 二値化に WASM を使わない（照合用）
}

export const DEFAULT_QUAD: QuadOptions = { windows: [11, 5, 15], c: 7, minSide: 9, maxSide: 160, minFit: 0.85, borderErrors: 2 };

// 符号（回した 4 通り）→ ID と回した回数
function rotCode(code: number): number {
  let out = 0;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) if ((code >> (r * 3 + c)) & 1) out |= 1 << (c * 3 + (2 - r));
  return out;
}

const SIB_TOL = 0.4;
const SURE_FIT = 0.97; // これ以上の割合で符号どおりに読めたマーカーは、ほかの窓で読み直さない
// 成分ごとに覚える数（画素の数と外接する矩形）
const STATS = 5;
const S_COUNT = 0;
const S_MINX = 1;
const S_MAXX = 2;
const S_MINY = 3;
const S_MAXY = 4;

export interface QuadStats {
  ms: number;
  runs: number;
  components: number;
  candidates: number;
  decoded: number;
}

export class QuadDetector {
  readonly options: QuadOptions;
  private readonly table = new Map<number, { id: number; rot: number }>();
  private thresh: Thresholder = makeThresholder();
  private runX0 = new Int16Array(0);
  private runX1 = new Int16Array(0);
  private runY = new Int16Array(0);
  private parent = new Int32Array(0);
  private stat = new Int32Array(0);
  private next = new Int32Array(0); // 同じ成分の次のラン（行の順）
  private tail = new Int32Array(0); // 成分（根のラン）ごとの最後のラン
  private lx = new Int32Array(0); // 成分の行ごとの左端・右端・行
  private rx = new Int32Array(0);
  private ys = new Int32Array(0);
  private hx = new Float64Array(0); // 凸包を作る点（x）
  private hy = new Float64Array(0);
  private rowStart = new Int32Array(0);
  private readonly seen = new Float64Array(3 * 512); // はっきり読めたマーカーの真ん中と大きさ（窓をまたいで読み直さない）
  private seenN = 0;
  private vbuf = new Uint8Array(0); // いまのフレームの明るさ（切り出しの中、行の幅は thresh.vs）
  private vreg: Region = { x: 0, y: 0, w: 0, h: 0 };
  private readonly weak = new Set<Marker>(); // 枠が欠けて読めたマーカー（detect の終わりで確かめる）
  readonly stats: QuadStats = { ms: 0, runs: 0, components: 0, candidates: 0, decoded: 0 };

  constructor(
    readonly scheme: StickerScheme,
    options: Partial<QuadOptions> = {},
  ) {
    this.options = { ...DEFAULT_QUAD, ...options };
    if (this.options.windows.some((x) => x > MAX_WIN || x % 2 === 0 || x < 3)) throw new Error(`二値化の窓は 3〜${MAX_WIN} の奇数`);
    if (this.options.forceJs) this.thresh = makeThresholder(true);
    codesOf(scheme).forEach((code, id) => {
      let x = code;
      for (let rot = 0; rot < 4; rot++, x = rotCode(x)) if (!this.table.has(x)) this.table.set(x, { id, rot });
    });
  }

  // region: 画像のこの部分だけで検出する。角の座標は画像全体の座標で返す
  detect(img: ImageLike, region?: Region): Marker[] {
    const t0 = performance.now();
    const r = region ?? { x: 0, y: 0, w: img.width, h: img.height };
    const w = r.w;
    const h = r.h;
    this.stats.runs = this.stats.components = this.stats.candidates = this.stats.decoded = 0;
    if (w < 24 || h < 24) return [];
    const T = this.thresh;
    const v = T.layout(w, h);
    const vs = T.vs;
    // 明るさ max(R, G, B)（行の余りは 0）
    const src = img.data;
    // 1 画素を 1 回で読めるとき（リトルエンディアン: R が下位のバイト）
    const px = src.byteOffset % 4 === 0 ? new Uint32Array(src.buffer, src.byteOffset, src.byteLength >> 2) : null;
    for (let y = 0; y < h; y++) {
      let o = y * vs;
      if (px) {
        let i = (r.y + y) * img.width + r.x;
        for (let x = 0; x < w; x++, i++, o++) {
          const p = px[i];
          const R = p & 255;
          const G = (p >>> 8) & 255;
          const B = (p >>> 16) & 255;
          v[o] = R > G ? (R > B ? R : B) : G > B ? G : B;
        }
      } else {
        let i = ((r.y + y) * img.width + r.x) * 4;
        for (let x = 0; x < w; x++, i += 4, o++) {
          const R = src[i];
          const G = src[i + 1];
          const B = src[i + 2];
          v[o] = R > G ? (R > B ? R : B) : G > B ? G : B;
        }
      }
      v.fill(0, o, (y + 1) * vs);
    }
    if (this.rowStart.length < h + 1) this.rowStart = new Int32Array(h + 1);
    this.vbuf = v as Uint8Array<ArrayBuffer>;
    this.vreg = r;
    const found = new Map<number, Marker[]>();
    this.seenN = 0;
    for (const win of this.options.windows) this.pass(img, r, win, found);
    this.stats.ms = performance.now() - t0;
    // 枠が欠けて読めたマーカー（指・ぶれ・ずれた四角）・細くつぶれたマーカーは、同じ ID のマーカーが隣（同じステッカーの 2×2 の間隔）にも読めたときだけ使う。
    // 符号の空きが少ない（512 通りのうち 216 通りがどれかの ID）ので、枠の欠けを許すとずれた四角が別の ID に読めることがある
    // （合成の 4 場面で 240 個中 3 個）。本物は 4 個並んでいるので、隣にも同じ ID が読めるのがふつう
    const all = [...found.values()].flat();
    const out = all.filter((m) => {
      if (!this.weak.has(m)) return true;
      const cx = (m.corners[0] + m.corners[2] + m.corners[4] + m.corners[6]) / 4;
      const cy = (m.corners[1] + m.corners[3] + m.corners[5] + m.corners[7]) / 4;
      // 隣のマーカーは、このマーカーの辺の向きに辺の 1.25 倍（ステッカーの中の 2×2 の間隔 0.5 / マーカーの辺 0.4）ずれた所にある。
      // マーカーの 2 辺を基底にしたずれ (a, b) が (±1.25, 0)・(0, ±1.25)・(±1.25, ±1.25) の近くで、大きさも近いこと
      const ux = (m.corners[2] - m.corners[0] + m.corners[4] - m.corners[6]) / 2;
      const uy = (m.corners[3] - m.corners[1] + m.corners[5] - m.corners[7]) / 2;
      const vx = (m.corners[6] - m.corners[0] + m.corners[4] - m.corners[2]) / 2;
      const vy = (m.corners[7] - m.corners[1] + m.corners[5] - m.corners[3]) / 2;
      const det = ux * vy - uy * vx;
      if (Math.abs(det) < 1e-6) return false;
      return all.some((o) => {
        if (o === m || o.id !== m.id) return false;
        if (o.side > m.side * 1.7 || m.side > o.side * 1.7) return false;
        const dx = (o.corners[0] + o.corners[2] + o.corners[4] + o.corners[6]) / 4 - cx;
        const dy = (o.corners[1] + o.corners[3] + o.corners[5] + o.corners[7]) / 4 - cy;
        const a = Math.abs((dx * vy - dy * vx) / det);
        const b = Math.abs((ux * dy - uy * dx) / det);
        const step = this.options.sibling ?? 1.25;
        const near = (t: number) => (t < SIB_TOL ? 0 : Math.abs(t - step) < SIB_TOL ? 1 : -1);
        const na = near(a);
        const nb = near(b);
        return na >= 0 && nb >= 0 && na + nb > 0;
      });
    });
    this.weak.clear();
    return out;
  }

  // 窓 1 つ分: 二値化 → ラン → 連結成分 → 四隅 → 符号
  private pass(img: ImageLike, r: Region, win: number, found: Map<number, Marker[]>): void {
    const { c: C, minSide, maxSide } = this.options;
    const w = r.w;
    const h = r.h;
    const T = this.thresh;
    const words = T.run(win, C);
    const stride = T.stride >> 2; // 1 行の語（32 ビット）の数
    let nRuns = 0;
    let cap = this.runX0.length;
    const rowStart = this.rowStart;
    let RX0 = this.runX0;
    let RX1 = this.runX1;
    let RY = this.runY;
    const lastWord = (w - 1) >> 5;
    const lastMask = w & 31 ? (1 << (w & 31)) - 1 : -1;
    // ビット列 → 連なり（ラン）。0 と 1 の変わり目だけを拾う（語ごとに、1 つずらしたものとの排他的論理和）
    for (let y = 0; y < h; y++) {
      rowStart[y] = nRuns;
      const o = y * stride;
      let prev = 0; // 前の語の最後のビット
      let start = -1;
      for (let j = 0; j <= lastWord; j++) {
        // 画像の幅より右のビット（8 画素ずつ処理した余り）は使わない
        const bits = j === lastWord ? words[o + j] & lastMask : words[o + j];
        let t = bits ^ ((bits << 1) | prev);
        prev = bits >>> 31;
        while (t) {
          const low = t & -t;
          const x = j * 32 + 31 - Math.clz32(low);
          t ^= low;
          if (start < 0) start = x;
          else {
            if (nRuns >= cap) {
              cap = this.grow(nRuns);
              RX0 = this.runX0;
              RX1 = this.runX1;
              RY = this.runY;
            }
            RX0[nRuns] = start;
            RX1[nRuns] = x - 1;
            RY[nRuns++] = y;
            start = -1;
          }
        }
      }
      if (start >= 0) {
        if (nRuns >= cap) {
          cap = this.grow(nRuns);
          RX0 = this.runX0;
          RX1 = this.runX1;
          RY = this.runY;
        }
        RX0[nRuns] = start;
        RX1[nRuns] = w - 1;
        RY[nRuns++] = y;
      }
    }
    rowStart[h] = nRuns;
    this.stats.runs += nRuns;
    if (!nRuns) return;
    const X0 = this.runX0;
    const X1 = this.runX1;
    const Y = this.runY;
    if (this.parent.length < nRuns) {
      this.parent = new Int32Array(cap);
      this.stat = new Int32Array(cap * STATS);
      this.next = new Int32Array(cap);
      this.tail = new Int32Array(cap);
    }
    const parent = this.parent;
    for (let i = 0; i < nRuns; i++) parent[i] = i;
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    // 上の行のランと 8 近傍でつながるものをまとめる
    for (let y = 1; y < h; y++) {
      let a = rowStart[y - 1];
      const aEnd = rowStart[y];
      const bEnd = rowStart[y + 1];
      for (let b = aEnd; b < bEnd; b++) {
        const b0 = X0[b] - 1;
        const b1 = X1[b] + 1;
        while (a < aEnd && X1[a] < b0) a++;
        for (let k = a; k < aEnd && X0[k] <= b1; k++) {
          const ra = find(k);
          const rb = find(b);
          if (ra !== rb) parent[rb < ra ? ra : rb] = rb < ra ? rb : ra;
        }
      }
    }
    // 成分ごとの大きさと、成分のランのつながり（根のランから行の順にたどれる）
    const st = this.stat;
    const next = this.next;
    const tail = this.tail;
    for (let i = 0; i < nRuns; i++) {
      const root = find(i);
      const s = root * STATS;
      const x0 = X0[i];
      const x1 = X1[i];
      next[i] = -1;
      if (root === i) {
        st[s + S_COUNT] = x1 - x0 + 1;
        st[s + S_MINX] = x0;
        st[s + S_MAXX] = x1;
        st[s + S_MINY] = Y[i];
        st[s + S_MAXY] = Y[i];
        tail[root] = i;
        continue;
      }
      st[s + S_COUNT] += x1 - x0 + 1;
      if (x0 < st[s + S_MINX]) st[s + S_MINX] = x0;
      if (x1 > st[s + S_MAXX]) st[s + S_MAXX] = x1;
      st[s + S_MAXY] = Y[i];
      next[tail[root]] = i;
      tail[root] = i;
    }
    // 大きさの合う成分 → 四隅 → 符号
    const edgeTop = win >> 1;
    const edgeBottom = h - 1 - (win >> 1);
    const lo = minSide * 0.6;
    const hi = maxSide * 1.5;
    for (let i = 0; i < nRuns; i++) {
      if (parent[i] !== i) continue;
      this.stats.components++;
      const s = i * STATS;
      const bw = st[s + S_MAXX] - st[s + S_MINX] + 1;
      const bh = st[s + S_MAXY] - st[s + S_MINY] + 1;
      const big = bw > bh ? bw : bh;
      const small = bw > bh ? bh : bw;
      if (big < minSide || big > hi || small < lo) continue;
      // 二値化できる範囲の縁に触れた成分は、画像（切り出し）の縁で切れたマーカー（切れた四角を別の ID に読むことがある）
      if (st[s + S_MINY] <= edgeTop || st[s + S_MAXY] >= edgeBottom || st[s + S_MINX] <= 8 || st[s + S_MAXX] >= w - 1) continue;
      const count = st[s + S_COUNT];
      // 行ごとの左端・右端（成分の縁）→ 凸包 → 四隅
      const quad = this.quadOf(i, bh);
      if (!quad) continue;
      const area = quadArea(quad);
      if (area < minSide * minSide * 0.6 || count > area * 1.25) continue;
      // 細くつぶれた四角（ほとんど真横から見た面）: いちばん長い辺に対する高さが minSide に満たない（1 マス 2 画素未満）と別の ID に
      // 読めることがある（合成で、真横に近い上の面のマーカーを違う ID に読んだ）。半分に満たなければ読まず、それ以上でも隣に同じ ID が
      // 読めたときだけ使う（下の weak）
      let longest = 0;
      for (let k = 0; k < 4; k++) {
        const d = Math.hypot(quad[(k + 1) % 4][0] - quad[k][0], quad[(k + 1) % 4][1] - quad[k][1]);
        if (d > longest) longest = d;
      }
      if (area < longest * minSide * 0.5) continue;
      const thin = area < longest * minSide;
      // 前の窓で同じ四角をはっきり読めていれば、読み直さない（窓ごとに同じマーカーが候補になる）
      const qx = (quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4 + r.x;
      const qy = (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4 + r.y;
      let known = false;
      for (let k = 0; k < this.seenN && !known; k++) {
        const o = k * 3;
        const side = this.seen[o + 2];
        if (Math.abs(this.seen[o] - qx) < side * 0.15 && Math.abs(this.seen[o + 1] - qy) < side * 0.15 && Math.abs(area - side * side) < side * side * 0.3) known = true;
      }
      if (known) continue;
      this.stats.candidates++;
      // 画像全体の座標に
      const q: Pt[] = quad.map(([x, y]) => [x + r.x, y + r.y]);
      const hit = this.decode(img, q);
      if (!hit) continue;
      let ordered = [0, 1, 2, 3].flatMap((k) => q[(k + hit.rot) % 4]);
      let m = this.describe(img, hit.id, ordered);
      // 辺を明暗の境目に合わせ直す。符号どおりの割合が大きく下がらなければそちらを使う（細くつぶれたマーカーは、正しい角の方が
      // マスの中心付近の読みが少し悪くなることがある）
      if (this.options.refine !== false) {
        const fine = this.refine(ordered, m.contrastMax);
        if (fine) {
          const mf = this.describe(img, hit.id, fine);
          if (mf.fit >= m.fit - (this.options.refineTol ?? 0.06) && (mf.fit >= this.options.minFit || m.fit < this.options.minFit)) {
            m = mf;
            ordered = fine;
          }
        }
      }
      if (m.fit < this.options.minFit) continue;
      if (thin || (hit.bad && m.fit < (this.options.weakFit ?? 2))) this.weak.add(m);
      else if (m.fit >= SURE_FIT && this.seenN * 3 + 3 <= this.seen.length) {
        const o = this.seenN++ * 3;
        this.seen[o] = (ordered[0] + ordered[2] + ordered[4] + ordered[6]) / 4;
        this.seen[o + 1] = (ordered[1] + ordered[3] + ordered[5] + ordered[7]) / 4;
        this.seen[o + 2] = Math.sqrt(area);
      }
      this.stats.decoded++;
      const cx = (ordered[0] + ordered[2] + ordered[4] + ordered[6]) / 4;
      const cy = (ordered[1] + ordered[3] + ordered[5] + ordered[7]) / 4;
      // 同じマーカーを別の窓でも見つけたら、符号どおりの割合の高い方（同じ ID で、真ん中が辺の半分より近い）
      let list = found.get(hit.id);
      if (!list) found.set(hit.id, (list = []));
      let dup = -1;
      for (let k = 0; k < list.length && dup < 0; k++) {
        const o = list[k];
        const ox = (o.corners[0] + o.corners[2] + o.corners[4] + o.corners[6]) / 4;
        const oy = (o.corners[1] + o.corners[3] + o.corners[5] + o.corners[7]) / 4;
        if (Math.hypot(ox - cx, oy - cy) < Math.max(m.side, o.side) * 0.5) dup = k;
      }
      if (dup < 0) list.push(m);
      else if (list[dup].fit < m.fit) {
        this.weak.delete(list[dup]);
        list[dup] = m;
      } else this.weak.delete(m);
    }
  }

  // 成分（根のラン root、高さ rows 行）の四隅。行ごとの左端・右端の点の凸包を作り、失う面積のいちばん小さい頂点から除いて 4 つにする
  // （輪郭を四角形に近似するのと同じ。8 方向の端の点だけで決めていた間は、斜めから見て細長くつぶれたマーカーの鈍い角を拾えなかった）。
  // 画像の座標で時計回り（左上 → 右上 → 右下 → 左下の向き）
  private quadOf(root: number, rows: number): Pt[] | null {
    const X0 = this.runX0;
    const X1 = this.runX1;
    const Y = this.runY;
    const next = this.next;
    if (this.hx.length < rows * 2 + 4) {
      this.hx = new Float64Array(rows * 4 + 16);
      this.hy = new Float64Array(rows * 4 + 16);
    }
    // 行ごとの左端・右端（ランは行の順・行の中では左から）
    if (this.lx.length < rows + 1) {
      this.lx = new Int32Array(rows * 2 + 8);
      this.rx = new Int32Array(rows * 2 + 8);
      this.ys = new Int32Array(rows * 2 + 8);
    }
    const lx = this.lx;
    const rx = this.rx;
    const ys = this.ys;
    let y = -1;
    let n = 0;
    for (let i = root; i >= 0; i = next[i]) {
      if (Y[i] !== y) {
        y = Y[i];
        ys[n] = y;
        lx[n] = X0[i];
        rx[n++] = X1[i];
      } else {
        if (X0[i] < lx[n - 1]) lx[n - 1] = X0[i];
        if (X1[i] > rx[n - 1]) rx[n - 1] = X1[i];
      }
    }
    if (n < 3) return null;
    // 凸包: 左の鎖（上から下へ、左に凸）と右の鎖（下から上へ）
    const hx = this.hx;
    const hy = this.hy;
    let m = 0;
    const push = (px: number, py: number, base: number) => {
      // 最後の 2 点と (px, py) が右回り・一直線なら、真ん中の点はいらない（y が下向きの座標で、左の鎖を上から下へ → 右の鎖を下から上へ = 反時計回り）
      while (m - base >= 2 && (hx[m - 1] - hx[m - 2]) * (py - hy[m - 2]) - (hy[m - 1] - hy[m - 2]) * (px - hx[m - 2]) >= 0) m--;
      hx[m] = px;
      hy[m++] = py;
    };
    for (let k = 0; k < n; k++) push(lx[k], ys[k], 0);
    const base = m - 1;
    for (let k = n - 1; k >= 0; k--) push(rx[k], ys[k], base);
    // 始めの点に戻っていたら除く
    if (m > 1 && hx[m - 1] === hx[0] && hy[m - 1] === hy[0]) m--;
    if (m < 4) return null;
    // 頂点を 4 つまで減らす: 両隣との三角形の面積（除いたときに失う面積）がいちばん小さい頂点から
    const idx: number[] = [];
    for (let k = 0; k < m; k++) idx.push(k);
    while (idx.length > 4) {
      let best = -1;
      let bestA = Infinity;
      const L = idx.length;
      for (let k = 0; k < L; k++) {
        const a = idx[(k + L - 1) % L];
        const b = idx[k];
        const c = idx[(k + 1) % L];
        const area = Math.abs((hx[b] - hx[a]) * (hy[c] - hy[a]) - (hy[b] - hy[a]) * (hx[c] - hx[a]));
        if (area < bestA) {
          bestA = area;
          best = k;
        }
      }
      idx.splice(best, 1);
    }
    const q: Pt[] = idx.map((k) => [hx[k], hy[k]]);
    return quadArea(q) < 0 ? [q[0], q[3], q[2], q[1]] : q;
  }

  private grow(n: number): number {
    const cap = Math.max(4096, n * 2);
    const g16 = (a: Int16Array) => {
      const b = new Int16Array(cap);
      b.set(a.subarray(0, n));
      return b;
    };
    this.runX0 = g16(this.runX0);
    this.runX1 = g16(this.runX1);
    this.runY = g16(this.runY);
    return cap;
  }

  // 四角（左上から時計回りの順とは限らない向き）の 5×5 のマスの中心付近を読み、枠が黒く、中の 3×3 が辞書のどれかに一致すれば ID と回転
  private readonly val = new Float32Array(25);
  private decode(img: ImageLike, q: Pt[]): { id: number; rot: number; bad: number } | null {
    const H = squareToQuad(q);
    if (!H) return null;
    const val = this.val;
    const W = img.width;
    const Hh = img.height;
    const data = img.data;
    // 先にマスの真ん中の 1 点ずつだけで枠を確かめる（候補のほとんどはマーカーではなく、ここで捨てられる）
    let lo = 255;
    let hi = 0;
    for (let k = 0; k < 25; k++) {
      const u = ((k % 5) + 0.5) / 5;
      const vv = (((k / 5) | 0) + 0.5) / 5;
      const den = H[6] * u + H[7] * vv + 1;
      const xi = Math.round((H[0] * u + H[1] * vv + H[2]) / den);
      const yi = Math.round((H[3] * u + H[4] * vv + H[5]) / den);
      if (xi < 0 || yi < 0 || xi >= W || yi >= Hh) return null;
      const i = (yi * W + xi) * 4;
      const R = data[i];
      const G = data[i + 1];
      const B = data[i + 2];
      const m = R > G ? (R > B ? R : B) : G > B ? G : B;
      val[k] = m;
      if (m < lo) lo = m;
      if (m > hi) hi = m;
    }
    if (hi - lo < 24) return null;
    {
      const thr0 = (lo + hi) / 2;
      let bright = 0;
      for (let k = 0; k < 25; k++) {
        const rr = (k / 5) | 0;
        const cc = k % 5;
        if ((rr === 0 || cc === 0 || rr === 4 || cc === 4) && val[k] > thr0) bright++;
      }
      if (bright > this.options.borderErrors + 2) return null;
    }
    lo = 255;
    hi = 0;
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 5; c++) {
        let sum = 0;
        let cnt = 0;
        for (let dy = -0.2; dy <= 0.21; dy += 0.2)
          for (let dx = -0.2; dx <= 0.21; dx += 0.2) {
            const u = (c + 0.5 + dx) / 5;
            const vv = (r + 0.5 + dy) / 5;
            const den = H[6] * u + H[7] * vv + 1;
            const xi = Math.round((H[0] * u + H[1] * vv + H[2]) / den);
            const yi = Math.round((H[3] * u + H[4] * vv + H[5]) / den);
            if (xi < 0 || yi < 0 || xi >= W || yi >= Hh) continue;
            const i = (yi * W + xi) * 4;
            const R = data[i];
            const G = data[i + 1];
            const B = data[i + 2];
            sum += R > G ? (R > B ? R : B) : G > B ? G : B;
            cnt++;
          }
        if (!cnt) return null;
        const m = sum / cnt;
        val[r * 5 + c] = m;
        if (m < lo) lo = m;
        if (m > hi) hi = m;
      }
    if (hi - lo < 30) return null;
    const thr = (lo + hi) / 2;
    let bad = 0;
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) if ((r === 0 || c === 0 || r === 4 || c === 4) && val[r * 5 + c] > thr && ++bad > this.options.borderErrors) return null;
    let code = 0;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) if (val[(r + 1) * 5 + c + 1] > thr) code |= 1 << (r * 3 + c);
    const hit = this.table.get(code);
    return hit ? { id: hit.id, rot: hit.rot, bad } : null;
  }

  describeMarker(img: ImageLike, id: number, c: number[]): Marker {
    return this.describe(img, id, c);
  }

  // 四隅を合わせ直す: 辺ごとに、辺に沿った点から辺に垂直に明るさをたどり、内側が暗く外側が明るい境目（明るさの変化がいちばん大きい所）を
  // 探して直線を当て、隣の辺の直線との交点を角にする。二値化の成分の四隅は、斜めから見たマーカーの尖った角が丸く欠けて 3〜5 画素ずれる
  // （OpenCV の検出も同じ）。辺は真ん中の 7 割だけ使うので角の欠けに引かれない。2 回（±3 画素 → ±1 画素）。
  // 辺が短い・境目が見つからない辺は元の直線のまま。角が大きく動いたら使わない
  private readonly fx = new Float64Array(16);
  private readonly fy = new Float64Array(16);
  private readonly fw = new Float64Array(16);
  private refine(c: number[], contrast: number): number[] | null {
    const v = this.vbuf;
    const vs = this.thresh.vs;
    const reg = this.vreg;
    const w = reg.w;
    const h = reg.h;
    const gmin = Math.max(10, contrast * 0.2);
    let cur = c;
    const cx0 = (c[0] + c[2] + c[4] + c[6]) / 4;
    const cy0 = (c[1] + c[3] + c[5] + c[7]) / 4;
    const L = this.lines;
    for (let pass = 0; pass < 2; pass++) {
      let fitted = 0;
      for (let k = 0; k < 4; k++) {
        const ax = cur[k * 2];
        const ay = cur[k * 2 + 1];
        const bx = cur[((k + 1) & 3) * 2];
        const by = cur[((k + 1) & 3) * 2 + 1];
        const len = Math.hypot(bx - ax, by - ay);
        const dx = (bx - ax) / (len || 1);
        const dy = (by - ay) / (len || 1);
        // 元の直線
        L[k * 4] = ax;
        L[k * 4 + 1] = ay;
        L[k * 4 + 2] = dx;
        L[k * 4 + 3] = dy;
        if (len < 6) continue;
        // 外向きの法線
        let nx = dy;
        let ny = -dx;
        if (nx * ((ax + bx) / 2 - cx0) + ny * ((ay + by) / 2 - cy0) < 0) {
          nx = -nx;
          ny = -ny;
        }
        // 探す幅: 1 回目は 3 画素まで、ただしこの辺に垂直な向きのマスの大きさの 0.6 倍まで（細くつぶれたマーカーでは、内側のマスの
        // 境目・隣のマーカーの縁が 2〜3 画素先にある）
        const ox = (cur[((k + 2) & 3) * 2] + cur[((k + 3) & 3) * 2]) / 2;
        const oy = (cur[((k + 2) & 3) * 2 + 1] + cur[((k + 3) & 3) * 2 + 1]) / 2;
        const cell = Math.abs(nx * (ox - ax) + ny * (oy - ay)) / 5;
        const R = pass === 0 ? Math.max(1, Math.min(3, Math.round(cell * 0.6))) : 1;
        const K = len >= 20 ? 10 : len >= 12 ? 6 : 4;
        let n = 0;
        let sw = 0;
        let mx = 0;
        let my = 0;
        for (let i = 0; i < K; i++) {
          const sP = 0.15 + (0.7 * (i + 0.5)) / K;
          const px = ax + (bx - ax) * sP - reg.x;
          const py = ay + (by - ay) * sP - reg.y;
          // 明るさの並び（−R−0.5 〜 R+0.5、1 画素ごと）と、隣どうしの差（−R 〜 R）
          let prev = -1;
          let best = 0;
          let bt = 0;
          let gPrev = 0;
          let gBest0 = 0;
          let gBest1 = 0;
          let last = 0;
          let ok = true;
          for (let j = 0; j <= 2 * R + 1; j++) {
            const t = j - R - 0.5;
            const x = px + nx * t;
            const y = py + ny * t;
            const x0 = Math.floor(x);
            const y0 = Math.floor(y);
            if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) {
              ok = false;
              break;
            }
            const u = x - x0;
            const q = y - y0;
            const o = y0 * vs + x0;
            const f = (v[o] * (1 - u) + v[o + 1] * u) * (1 - q) + (v[o + vs] * (1 - u) + v[o + vs + 1] * u) * q;
            if (j > 0) {
              const g = f - prev;
              if (last === 1) {
                gBest1 = g;
                last = 0;
              }
              if (g > best) {
                best = g;
                bt = j - R - 1;
                gBest0 = gPrev;
                gBest1 = 0;
                last = 1;
              }
              gPrev = g;
            }
            prev = f;
          }
          if (!ok || best < gmin) continue;
          // 山の頂上を放物線で（端なら動かさない）
          const den = gBest0 - 2 * best + gBest1;
          if (bt > -R && bt < R && den < 0) bt += Math.max(-0.5, Math.min(0.5, (0.5 * (gBest0 - gBest1)) / den));
          const qx = px + nx * bt + reg.x;
          const qy = py + ny * bt + reg.y;
          this.fx[n] = qx;
          this.fy[n] = qy;
          this.fw[n++] = best;
          sw += best;
          mx += qx * best;
          my += qy * best;
        }
        if (n < 3 || n * 2 < K) continue;
        // 重み付きの主軸。1 回当ててから、直線から 0.75 画素より離れた点（別の境目を拾った点）を除いて当て直す
        let ux = dx;
        let uy = dy;
        for (let round = 0; round < 2; round++) {
          if (round) {
            let m2 = 0;
            let s2 = 0;
            let ax2 = 0;
            let ay2 = 0;
            for (let i = 0; i < n; i++) {
              const res = Math.abs((this.fx[i] - mx) * uy - (this.fy[i] - my) * ux);
              if (res > 0.75) this.fw[i] = 0;
              else {
                m2++;
                s2 += this.fw[i];
                ax2 += this.fx[i] * this.fw[i];
                ay2 += this.fy[i] * this.fw[i];
              }
            }
            if (m2 === n) break;
            if (m2 < 3 || m2 * 2 < K) {
              n = 0;
              break;
            }
            sw = s2;
            mx = ax2;
            my = ay2;
          }
          mx /= sw;
          my /= sw;
          let sxx = 0;
          let sxy = 0;
          let syy = 0;
          for (let i = 0; i < n; i++) {
            const ex = this.fx[i] - mx;
            const ey = this.fy[i] - my;
            sxx += this.fw[i] * ex * ex;
            sxy += this.fw[i] * ex * ey;
            syy += this.fw[i] * ey * ey;
          }
          const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
          ux = Math.cos(th);
          uy = Math.sin(th);
          if (ux * dx + uy * dy < 0) {
            ux = -ux;
            uy = -uy;
          }
        }
        if (!n) continue;
        if (ux * dx + uy * dy < 0.94) continue; // 20° より回った直線は使わない
        L[k * 4] = mx;
        L[k * 4 + 1] = my;
        L[k * 4 + 2] = ux;
        L[k * 4 + 3] = uy;
        fitted++;
      }
      if (!fitted) return pass ? cur : null;
      // 隣の辺との交点（角 k は辺 k−1 と辺 k）
      const out = new Array<number>(8);
      for (let k = 0; k < 4; k++) {
        const a = ((k + 3) & 3) * 4;
        const b = k * 4;
        const det = L[a + 2] * L[b + 3] - L[a + 3] * L[b + 2];
        if (Math.abs(det) < 0.05) return pass ? cur : null;
        const t = ((L[b] - L[a]) * L[b + 3] - (L[b + 1] - L[a + 1]) * L[b + 2]) / det;
        const x = L[a] + L[a + 2] * t;
        const y = L[a + 1] + L[a + 3] * t;
        if (Math.hypot(x - c[k * 2], y - c[k * 2 + 1]) > 9) return pass ? cur : null;
        out[k * 2] = x;
        out[k * 2 + 1] = y;
      }
      cur = out;
    }
    return cur;
  }
  private readonly lines = new Float64Array(16);

  private describe(img: ImageLike, id: number, c0: number[]): Marker {
    const c = c0.map((v) => Math.round(v * 10) / 10);
    const pts = cornerPoints(c);
    let side = 0;
    for (let i = 0; i < 4; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % 4];
      side += Math.hypot(b[0] - a[0], b[1] - a[1]) / 4;
    }
    const angle = (Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]) * 180) / Math.PI;
    const m = this.measure(img, pts, markerBits(this.scheme, id));
    return { id, corners: c, side, angle, ...m };
  }

  // マスの中心付近（3×3 点）を読み、明るいマスの色・明るいマス − 黒いマスの差・明暗が符号どおりの割合を出す
  // （src/aruco/detect.ts の measureCells と同じ値。射影変換を 4 点から直接求め、点ごとの入れ物を作らない）
  private readonly sv = new Uint8Array(225);
  private readonly sl = new Uint8Array(225);
  private measure(img: ImageLike, pts: Pt[], bits: Uint8Array): Pick<Marker, "rgb" | "contrastGray" | "contrastMax" | "fit"> {
    const H = squareToQuad(pts);
    if (!H) return measureCells(img, pts, bits, 5);
    const W = img.width;
    const Hh = img.height;
    const data = img.data;
    const sv = this.sv;
    const sl = this.sl;
    let lr = 0, lg = 0, lb = 0, lgray = 0, lmax = 0, nl = 0;
    let dgray = 0, dmax = 0, nd = 0;
    let n = 0;
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 5; c++) {
        const light = bits[r * 5 + c] > 0;
        for (let iy = -1; iy <= 1; iy++)
          for (let ix = -1; ix <= 1; ix++) {
            const u = (c + 0.5 + ix * 0.2) / 5;
            const vv = (r + 0.5 + iy * 0.2) / 5;
            const den = H[6] * u + H[7] * vv + 1;
            const xi = Math.round((H[0] * u + H[1] * vv + H[2]) / den);
            const yi = Math.round((H[3] * u + H[4] * vv + H[5]) / den);
            if (xi < 0 || yi < 0 || xi >= W || yi >= Hh) continue;
            const i = (yi * W + xi) * 4;
            const R = data[i];
            const G = data[i + 1];
            const B = data[i + 2];
            const mx = R > G ? (R > B ? R : B) : G > B ? G : B;
            const gray = 0.299 * R + 0.587 * G + 0.114 * B;
            sv[n] = mx;
            sl[n++] = light ? 1 : 0;
            if (light) {
              lr += R; lg += G; lb += B; lgray += gray; lmax += mx; nl++;
            } else {
              dgray += gray; dmax += mx; nd++;
            }
          }
      }
    const L = Math.max(1, nl);
    const D = Math.max(1, nd);
    const mid = (lmax / L + dmax / D) / 2;
    let ok = 0;
    for (let k = 0; k < n; k++) if (sv[k] > mid === sl[k] > 0) ok++;
    return {
      rgb: [Math.round(lr / L), Math.round(lg / L), Math.round(lb / L)],
      contrastGray: nl && nd ? Math.round(lgray / L - dgray / D) : 0,
      contrastMax: nl && nd ? Math.round(lmax / L - dmax / D) : 0,
      fit: n ? ok / n : 0,
    };
  }
}

const quadArea = (q: Pt[]): number => {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i];
    const n = q[(i + 1) % 4];
    a += p[0] * n[1] - n[0] * p[1];
  }
  return a / 2;
};

// 単位正方形 (0,0)-(1,0)-(1,1)-(0,1) → 四角 q の射影変換（[a b c; d e f; g h 1] の 8 つ。Heckbert の式）
function squareToQuad(q: Pt[]): number[] | null {
  const [x0, y0] = q[0];
  const [x1, y1] = q[1];
  const [x2, y2] = q[2];
  const [x3, y3] = q[3];
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const sx = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-9) return null;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
}

// ArucoBench（OpenCV）の代わりに使う入れ物（src/vision/arucoFrame.ts の detectorFor）
export class QuadBench implements MarkerDetector {
  private readonly det: QuadDetector;
  private scratch: Uint8ClampedArray | null = null;
  constructor(
    readonly scheme: StickerScheme,
    options: Partial<QuadOptions> = {},
  ) {
    this.det = new QuadDetector(scheme, options);
  }

  // shrink 2: 切り出しを縦横半分に縮めてから検出する（マーカーが大きく映っているとき）
  detect(img: ImageLike, region?: Region, shrink: 1 | 2 = 1): DetectResult[] {
    const t0 = performance.now();
    let markers: Marker[];
    if (region && shrink === 2) {
      const w = region.w >> 1;
      const h = region.h >> 1;
      const n = w * h * 4;
      if (!this.scratch || this.scratch.length < n) this.scratch = new Uint8ClampedArray(n);
      const data = this.scratch.subarray(0, n);
      halveRegionInto(data, img, region);
      markers = this.det.detect({ data, width: w, height: h });
      // 縮めた画像の画素 i の中心は、元の画素 2i と 2i+1 の間
      for (const m of markers) {
        m.corners = m.corners.map((v, i) => Math.round((v * 2 + 0.5 + (i % 2 ? region.y : region.x)) * 10) / 10);
        m.side *= 2;
      }
    } else markers = this.det.detect(img, region);
    return [{ markers, ms: performance.now() - t0 }];
  }

  describeMarker(img: ImageLike, id: number, c: number[]): Marker {
    return this.det.describeMarker(img, id, c);
  }
  bitsOf(id: number): Uint8Array {
    return markerBits(this.scheme, id);
  }
  get cellCount(): number {
    return 5;
  }
  delete(): void {}
}

// ---- 二値化 ----
// 明るさ v（行の幅 vs）を、まわり win × win の平均より c 以上暗い画素を 1 にしたビット列にする（行の幅 stride バイト = 32 ビットの語の
// 倍数。画素 x は x >> 5 語目の x & 31 ビット）。上下の half 行・左の 8 列は 0、右の端は窓が画像の外（0）にかかる。
// WASM SIMD（scripts/wasm/thresh.wat）が使えなければ同じ結果を出す JS で（tests/quadDetect.test.ts で照合）
export interface Thresholder {
  readonly simd: boolean;
  vs: number;
  stride: number;
  layout(w: number, h: number): Uint8Array; // 明るさを書く入れ物（vs × h）
  run(win: number, c: number): Uint32Array; // ビット列（stride / 4 × h 語）
}

const MAX_WIN = 15; // (255 + c) × win² と窓の和が 16 ビットに収まる大きさ

class JsThresholder implements Thresholder {
  readonly simd = false;
  vs = 0;
  stride = 0;
  private w = 0;
  private h = 0;
  private v = new Uint8Array(0);
  private col = new Int32Array(0);
  private words = new Uint32Array(0);
  layout(w: number, h: number): Uint8Array {
    this.w = w;
    this.h = h;
    this.vs = ((w + 15) >> 3) << 3;
    this.stride = ((w + 39) >> 5) << 2;
    if (this.v.length < this.vs * h) this.v = new Uint8Array(this.vs * h);
    if (this.col.length < w + 32) this.col = new Int32Array(w + 32);
    const n = (this.stride >> 2) * h;
    if (this.words.length < n) this.words = new Uint32Array(n);
    return this.v;
  }
  run(win: number, c: number): Uint32Array {
    const { w, h, vs, v, col, words } = this;
    const sw = this.stride >> 2;
    const half = win >> 1;
    const area = win * win;
    words.fill(0, 0, sw * h);
    col.fill(0);
    if (h < win) return words;
    for (let y = 0; y < win - 1; y++) for (let x = 0, o = y * vs; x < w; x++) col[x] += v[o + x];
    for (let y = half; y < h - half; y++) {
      for (let x = 0, o = (y + half) * vs; x < w; x++) col[x] += v[o + x];
      if (y > half) for (let x = 0, o = (y - half - 1) * vs; x < w; x++) col[x] -= v[o + x];
      const vo = y * vs;
      const wo = y * sw;
      let sum = 0;
      for (let k = 0; k < win; k++) sum += col[8 - half + k];
      for (let x = 8; x < w; x++) {
        if ((v[vo + x] + c) * area < sum) words[wo + (x >> 5)] |= 1 << (x & 31);
        sum += col[x - half + win] - col[x - half];
      }
    }
    return words;
  }
}

class WasmThresholder implements Thresholder {
  readonly simd = true;
  vs = 0;
  stride = 0;
  private w = 0;
  private h = 0;
  private vOff = 0;
  private maskOff = 0;
  private readonly mem: WebAssembly.Memory;
  private readonly fn: (v: number, vs: number, w: number, h: number, win: number, c: number, col: number, mask: number, stride: number) => void;
  constructor(module: WebAssembly.Module) {
    const inst = new WebAssembly.Instance(module, {});
    this.mem = inst.exports.mem as WebAssembly.Memory;
    this.fn = inst.exports.thresh as never;
  }
  layout(w: number, h: number): Uint8Array {
    this.w = w;
    this.h = h;
    this.vs = ((w + 15) >> 3) << 3;
    this.stride = ((w + 39) >> 5) << 2;
    const colBytes = (w + 32) * 2;
    this.vOff = (COL_OFF + colBytes + 63) & ~63;
    this.maskOff = (this.vOff + this.vs * h + 63) & ~63;
    const need = this.maskOff + this.stride * h + 64;
    const have = this.mem.buffer.byteLength;
    if (need > have) this.mem.grow(Math.ceil((need - have) / 65536));
    return new Uint8Array(this.mem.buffer, this.vOff, this.vs * h);
  }
  run(win: number, c: number): Uint32Array {
    this.fn(this.vOff, this.vs, this.w, this.h, win, c, COL_OFF, this.maskOff, this.stride);
    return new Uint32Array(this.mem.buffer, this.maskOff, (this.stride >> 2) * this.h);
  }
}
const COL_OFF = 64;

let wasmModule: WebAssembly.Module | null | undefined;
// forceJs: JS の二値化を使う（照合用）
export function makeThresholder(forceJs = false): Thresholder {
  if (forceJs) return new JsThresholder();
  if (wasmModule === undefined) {
    wasmModule = null;
    try {
      const bin = atob(THRESH_WASM);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      // SIMD に対応していない環境では検証に通らない
      if (typeof WebAssembly !== "undefined" && WebAssembly.validate(bytes)) wasmModule = new WebAssembly.Module(bytes);
    } catch {
      wasmModule = null;
    }
  }
  return wasmModule ? new WasmThresholder(wasmModule) : new JsThresholder();
}

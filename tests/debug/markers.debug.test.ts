// マーカーの辞書の比較（ステッカー用）: 今の DICT_4X4_100（ID 0〜53）・AprilTag 16h5 の 12 個・自作の 4×4（12 個、距離 6）・
// 自作の 3×3（12 個）を、同じ大きさ・傾き・ぶれ・配色の合成画像で読ませて、正しく読めた・別の ID に読んだ・見逃しを数える。
//   npx vitest run -c vitest.debug.config.ts tests/debug/markers.debug.test.ts
//   SCHEMES="3×3"（名前で絞る）・PERID=1（ID ごとの検出率）・RESCUE=1（捨てた四角の読み直し）・PARAMS='{"adaptiveThreshWinSizeStep":5}'・DIAG2=1（取りこぼしに候補があったか）
import { createRequire } from "node:module";
import { it } from "vitest";
import { ARUCO12_CODES, UNIQUE54_CODES } from "../../src/aruco/codes";
import { maxChannel, measureCells, rescueRejected } from "../../src/aruco/detect";
import { initOpenCv } from "../../src/vision/image";

type CV = any;
const pop = (x: number) => {
  let k = 0;
  while (x) (x &= x - 1), k++;
  return k;
};
function rot(code: number, n: number) {
  let out = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if ((code >> (r * n + c)) & 1) out |= 1 << (c * n + (n - 1 - r));
  return out;
}
const rots = (c: number, n: number) => [c, rot(c, n), rot(rot(c, n), n), rot(rot(rot(c, n), n), n)];
const dist = (a: number, b: number, n: number) => Math.min(...rots(b, n).map((x) => pop(a ^ x)));
const selfDist = (c: number, n: number) => Math.min(...rots(c, n).slice(1).map((x) => pop(c ^ x)));
function minDistance(codes: number[], n: number) {
  let d = Infinity;
  for (let i = 0; i < codes.length; i++) {
    d = Math.min(d, selfDist(codes[i], n));
    for (let j = i + 1; j < codes.length; j++) d = Math.min(d, dist(codes[i], codes[j], n));
  }
  return d;
}

// 辞書の符号（ビット 1 = 明るいセル、行優先 r*n+c）
function codesOf(cv: CV, dictId: number, ids: number[], n: number): number[] {
  const d = cv.getPredefinedDictionary(dictId);
  const out = ids.map((id) => {
    const m = new cv.Mat();
    cv.generateImageMarker(d, id, n + 2, m, 1);
    let code = 0;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m.data[(r + 1) * (n + 2) + c + 1] > 127) code |= 1 << (r * n + c);
    m.delete();
    return code;
  });
  d.delete();
  return out;
}

// 符号 → OpenCV の辞書のバイト列（Dictionary::getByteListFromBits と同じ並び: 4 つの回転を順に nbytes ずつ）
function byteList(code: number, n: number): Uint8Array {
  const nbytes = Math.ceil((n * n) / 8);
  const out = new Uint8Array(4 * nbytes);
  const bit = (r: number, c: number) => (code >> (r * n + c)) & 1;
  let cur = 0;
  let cnt = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const vals = [bit(r, c), bit(c, n - 1 - r), bit(n - 1 - r, n - 1 - c), bit(n - 1 - c, r)];
      for (let k = 0; k < 4; k++) out[k * nbytes + cur] = ((out[k * nbytes + cur] << 1) | vals[k]) & 255;
      if (++cnt === 8) (cnt = 0), cur++;
    }
  }
  return out;
}

function makeDict(cv: CV, codes: number[], n: number, maxCorr: number) {
  const nbytes = Math.ceil((n * n) / 8);
  const bl = new cv.Mat(codes.length, nbytes, cv.CV_8UC4);
  codes.forEach((code, i) => bl.data.set(byteList(code, n), i * 4 * nbytes));
  return new cv.aruco_Dictionary(bl, n, maxCorr);
}

// 12 個の中から、互いの距離が最大になる組を貪欲に選ぶ
function bestSubset(codes: number[], n: number, k: number) {
  let best: number[] = [];
  let bestD = -1;
  for (let start = 0; start < codes.length; start++) {
    const chosen = [start];
    while (chosen.length < k) {
      let bi = -1;
      let bd = -1;
      for (let i = 0; i < codes.length; i++) {
        if (chosen.includes(i)) continue;
        const d = Math.min(selfDist(codes[i], n), ...chosen.map((j) => dist(codes[i], codes[j], n)));
        if (d > bd) (bd = d), (bi = i);
      }
      chosen.push(bi);
    }
    const d = minDistance(chosen.map((i) => codes[i]), n);
    if (d > bestD) (bestD = d), (best = chosen);
  }
  return best;
}

interface Scheme {
  name: string;
  n: number;
  codes: number[];
  dict: any;
  apriltagRefine?: boolean;
  face: (id: number) => number; // ID → 面（色）
  ids?: number; // 使う ID の数（今の辞書は 0〜53）
}

const PALETTES: Record<string, [number, number, number][]> = {
  // 今の印刷（濃い色）と、明るく薄めた色（青・赤・緑を明るく。白と黄、赤と橙は人が見分けられる程度に残す）
  濃い: [
    [235, 235, 230],
    [190, 30, 40],
    [20, 150, 70],
    [240, 205, 30],
    [240, 115, 25],
    [20, 70, 175],
  ],
  明るい: [
    [250, 250, 248],
    [255, 120, 120],
    [120, 220, 135],
    [255, 236, 110],
    [255, 178, 95],
    [125, 175, 255],
  ],
};

let seed = 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

// 3×4 枚のステッカー（黒い本体の上）。s = ステッカーの辺（px）、k = 傾きによる縮み（cos）、blur = 露光中の移動（ステッカーの辺に対する割合）
function render(scheme: Scheme, ids: number[], palette: [number, number, number][], s: number, k: number, blur: number, W = 480, H = 360) {
  const n = scheme.n;
  const acc = new Float32Array(W * H * 3).fill(26);
  const angle = rnd() * Math.PI * 2;
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const pitch = s * 1.06;
  const truth: { id: number; x: number; y: number }[] = [];
  const bdir = rnd() * Math.PI;
  const bx = Math.cos(bdir) * blur * s;
  const by = Math.sin(bdir) * blur * s;
  const steps = blur > 0 ? 7 : 1;
  const SS = 2;
  let idx = 0;
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      const id = ids[idx++ % ids.length];
      const code = scheme.codes[id];
      const color = palette[scheme.face(id)];
      // 面の座標（傾いた面: 縦が k 倍）→ 画像（回転）
      const lx = (gx - 1.5) * pitch;
      const ly = (gy - 1) * pitch * k;
      const cx = W / 2 + ca * lx - sa * ly + (rnd() - 0.5) * 2;
      const cy = H / 2 + sa * lx + ca * ly + (rnd() - 0.5) * 2;
      truth.push({ id, x: cx, y: cy });
      const reach = s * 0.8 + Math.hypot(bx, by);
      for (let y = Math.max(0, Math.floor(cy - reach)); y < Math.min(H, Math.ceil(cy + reach)); y++) {
        for (let x = Math.max(0, Math.floor(cx - reach)); x < Math.min(W, Math.ceil(cx + reach)); x++) {
          let r = 0;
          let g = 0;
          let b = 0;
          let cover = 0;
          for (let st = 0; st < steps; st++) {
            const f = steps > 1 ? st / (steps - 1) - 0.5 : 0;
            for (let sy = 0; sy < SS; sy++) {
              for (let sx = 0; sx < SS; sx++) {
                const px = x + (sx + 0.5) / SS - cx - bx * f;
                const py = y + (sy + 0.5) / SS - cy - by * f;
                // 画像 → 面の座標（回転を戻して縦を 1/k）
                const qx = ca * px + sa * py;
                const qy = (-sa * px + ca * py) / k;
                const u = qx / s + 0.5;
                const v = qy / s + 0.5;
                if (u < 0 || v < 0 || u >= 1 || v >= 1) continue;
                const m = 0.08;
                const mu = (u - m) / (1 - 2 * m);
                const mv = (v - m) / (1 - 2 * m);
                let col = color;
                if (mu >= 0 && mv >= 0 && mu < 1 && mv < 1) {
                  const c = Math.floor(mu * (n + 2));
                  const rr = Math.floor(mv * (n + 2));
                  const light = c > 0 && rr > 0 && c <= n && rr <= n && (code >> ((rr - 1) * n + (c - 1))) & 1;
                  if (!light) col = [22, 22, 24];
                }
                r += col[0];
                g += col[1];
                b += col[2];
                cover++;
              }
            }
          }
          if (!cover) continue;
          const total = steps * SS * SS;
          const kk = cover / total;
          const i = (y * W + x) * 3;
          acc[i] = acc[i] * (1 - kk) + r / total;
          acc[i + 1] = acc[i + 1] * (1 - kk) + g / total;
          acc[i + 2] = acc[i + 2] * (1 - kk) + b / total;
        }
      }
    }
  }
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = acc[i * 3 + c] + gauss() * 3;
    data[i * 4 + 3] = 255;
  }
  return { img: { data, width: W, height: H }, truth };
}

it("辞書の比較", async () => {
  const cv: CV = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const range = (k: number) => Array.from({ length: k }, (_, i) => i);
  const aruco54 = codesOf(cv, cv.DICT_4X4_100, range(54), 4);
  const april30 = codesOf(cv, cv.DICT_APRILTAG_16h5, range(30), 4);
  const april12 = bestSubset(april30, 4, 12).map((i) => april30[i]);
  // バイト列の組み立てが OpenCV と同じことを確かめる
  {
    const d = cv.getPredefinedDictionary(cv.DICT_4X4_100);
    const ref = d.bytesList.data as Uint8Array;
    aruco54.forEach((code, i) => {
      const mine = byteList(code, 4);
      for (let j = 0; j < mine.length; j++) if (mine[j] !== ref[i * mine.length + j]) throw new Error(`byteList mismatch id ${i}`);
    });
  }
  const custom4 = [13055, 57523, 39574, 37154, 40272, 46761, 56744, 34771, 60348, 17973, 35016, 24160];
  // 3×3: 採用した 12 個（src/aruco/codes.ts。距離 2 の組は見分けやすい色どうし。距離 3 は 9 ビットでは取れない）
  const custom3 = ARUCO12_CODES;
  const f54 = (id: number) => Math.floor(id / 9);
  const f12 = (id: number) => id % 6; // 0〜5 = 面のセンター以外、6〜11 = センター
  const schemes: Scheme[] = [
    { name: "今: 4X4_100 の 54 個", n: 4, codes: aruco54, dict: cv.getPredefinedDictionary(cv.DICT_4X4_100), face: f54 },
    { name: "AprilTag 16h5 の 12 個・訂正 2", n: 4, codes: april12, dict: makeDict(cv, april12, 4, 2), face: f12 },
    { name: "AprilTag 16h5 の 12 個・訂正 1", n: 4, codes: april12, dict: makeDict(cv, april12, 4, 1), face: f12 },
    { name: "自作 4×4 の 12 個・訂正 2", n: 4, codes: custom4, dict: makeDict(cv, custom4, 4, 2), face: f12 },
    { name: "自作 4×4 の 12 個・訂正 1", n: 4, codes: custom4, dict: makeDict(cv, custom4, 4, 1), face: f12 },
    { name: "自作 4×4 の 12 個・訂正 0", n: 4, codes: custom4, dict: makeDict(cv, custom4, 4, 0), face: f12 },
    { name: "自作 3×3 の 12 個", n: 3, codes: custom3, dict: makeDict(cv, custom3, 3, 0), face: f12 },
    { name: "自作 3×3 の 54 個（マスごと）", n: 3, codes: UNIQUE54_CODES, dict: makeDict(cv, UNIQUE54_CODES, 3, 0), face: f54 },
  ].filter((sc) => !process.env.SCHEMES || process.env.SCHEMES.split(",").some((k) => sc.name.includes(k)));
  for (const sc of schemes) console.log(`R ${sc.name}: 最小距離 ${minDistance(sc.codes, sc.n)}・直せるビット ${sc.dict.maxCorrectionBits}`);

  const detectors = schemes.map((sc) => {
    const p = new cv.aruco_DetectorParameters();
    if (sc.apriltagRefine) p.cornerRefinementMethod = 3;
    // PARAMS='{"adaptiveThreshWinSizeStep":4}' などで全方式の検出パラメータを変える
    if (process.env.PARAMS) for (const [k, v] of Object.entries(JSON.parse(process.env.PARAMS))) p[k] = v;
    // 今の辞書は ID 0〜53 以外も読めてしまうので、54 以上は誤読として数える
    return new cv.aruco_ArucoDetector(sc.dict, p, new cv.aruco_RefineParameters(10, 3, true));
  });
  const sizes = [18, 22, 26, 32, 40];
  const tilts = [1, 0.57, 0.34]; // 正対・55°・70°
  const blurs = [0, 0.05, 0.1, 0.2];
  const TRIALS = 4;
  type Tally = { ok: number; wrong: number; sameColor: number; miss: number; extra: number; n: number };
  const tally = new Map<string, Tally>();
  const add = (key: string, t: Partial<Tally>) => {
    const x = tally.get(key) ?? { ok: 0, wrong: 0, sameColor: 0, miss: 0, extra: 0, n: 0 };
    for (const k of Object.keys(t) as (keyof Tally)[]) x[k] += t[k]!;
    tally.set(key, x);
  };
  const gray = new cv.Mat(360, 480, cv.CV_8UC1);
  for (const pal of Object.keys(PALETTES)) {
    for (const s of sizes) for (const k of tilts) for (const b of blurs) {
      for (let si = 0; si < schemes.length; si++) {
        const sc = schemes[si];
        seed = 1000 + s * 7 + Math.round(k * 100) * 13 + Math.round(b * 100) * 31; // 方式によらず同じ配置
        for (let tr = 0; tr < TRIALS; tr++) {
          const ids = range(12).map(() => Math.floor(rnd() * (sc.codes.length)));
          const { img, truth } = render(sc, ids, PALETTES[pal], s, k, b);
          maxChannel(img.data, gray.data);
          const corners = new cv.MatVector();
          const out = new cv.Mat();
          const rej = new cv.MatVector();
          detectors[si].detectMarkers(gray, corners, out, rej);
          const found = Array.from({ length: out.total() }, (_, i) => {
            const c = corners.get(i).data32F;
            return { id: out.data32S[i], x: (c[0] + c[2] + c[4] + c[6]) / 4, y: (c[1] + c[3] + c[5] + c[7]) / 4, corners: Array.from(c as Float32Array), side: s };
          });
          // RESCUE=1: OpenCV が捨てた四角をマスの中心で読み直す（3×3 の符号）。fit（明暗が符号どおりの割合）0.85 以上だけ
          if (process.env.RESCUE && sc.n === 3) {
            const rej2 = Array.from({ length: rej.size() }, (_, i) => Array.from(rej.get(i).data32F as Float32Array));
            for (const r of rescueRejected(img, rej2, sc.codes, found)) {
              const pts = [0, 1, 2, 3].map((i) => [r.corners[i * 2], r.corners[i * 2 + 1]] as [number, number]);
              const bits = new Uint8Array(25);
              for (let a = 0; a < 3; a++) for (let b2 = 0; b2 < 3; b2++) bits[(a + 1) * 5 + b2 + 1] = (sc.codes[r.id] >> (a * 3 + b2)) & 1;
              if (measureCells(img, pts, bits, 5).fit < 0.85) continue;
              found.push({ id: r.id, x: (r.corners[0] + r.corners[2] + r.corners[4] + r.corners[6]) / 4, y: (r.corners[1] + r.corners[3] + r.corners[5] + r.corners[7]) / 4, corners: r.corners, side: s });
            }
          }
          const rejAll = Array.from({ length: rej.size() }, (_, i) => Array.from(rej.get(i).data32F as Float32Array));
          corners.delete();
          out.delete();
          rej.delete();
          const used = new Set<number>();
          let ok = 0;
          let wrong = 0;
          let sameColor = 0; // 色では見抜けない誤読（同じ色の別の ID。今の辞書は 54 以上の ID も誤読に数える）
          for (const t of truth) {
            const fi = found.findIndex((f, i) => !used.has(i) && Math.hypot(f.x - t.x, f.y - t.y) < s * 0.4);
            if (k > 0.5 && b <= 0.1) add(`${pal}|${sc.name}|id${t.id}`, { ok: fi >= 0 && found[fi].id === t.id ? 1 : 0, n: 1 });
            if (process.env.DIAG2 && k > 0.5 && b <= 0.1 && fi < 0 && sc.n === 3) {
              const near = rejAll.some((c) => Math.hypot((c[0] + c[2] + c[4] + c[6]) / 4 - t.x, (c[1] + c[3] + c[5] + c[7]) / 4 - t.y) < s * 0.3);
              add(`${pal}|${sc.name}|miss${t.id}|${near ? "rej" : "none"}`, { n: 1 });
            }
            if (fi < 0) continue;
            used.add(fi);
            const got = found[fi].id;
            if (got === t.id) ok++;
            else {
              wrong++;
              if (got < sc.codes.length && sc.face(got) === sc.face(t.id)) sameColor++;
            }
          }
          const keys = [`${pal}|${sc.name}`, `${pal}|${sc.name}|s${s}`, `${pal}|${sc.name}|k${k}`, `${pal}|${sc.name}|b${b}`];
          // 現実的な条件（傾き 55° まで・ぶれ 10% まで）
          if (k > 0.5 && b <= 0.1) keys.push(`${pal}|${sc.name}|real`, `${pal}|${sc.name}|real|s${s}`);
          for (const key of keys) add(key, { ok, wrong, sameColor, miss: truth.length - ok - wrong, extra: found.length - used.size, n: truth.length });
        }
      }
    }
  }
  const pct = (a: number, n: number) => `${((100 * a) / Math.max(1, n)).toFixed(1)}%`;
  for (const pal of Object.keys(PALETTES)) {
    console.log(`R \n== 配色: ${pal}（現実的な条件: 傾き 55° まで・ぶれ 10% まで）==`);
    for (const sc of schemes) {
      const t = tally.get(`${pal}|${sc.name}|real`)!;
      const bys = sizes.map((v) => pct(tally.get(`${pal}|${sc.name}|real|s${v}`)!.ok, tally.get(`${pal}|${sc.name}|real|s${v}`)!.n)).join(" ");
      console.log(`R ${sc.name}: 正 ${pct(t.ok, t.n)} 誤読 ${pct(t.wrong, t.n)}（${t.wrong}、うち同じ色 ${t.sameColor}）| 大きさ ${sizes.join("/")}px: ${bys}`);
      if (process.env.DIAG2) console.log(`R   取りこぼし（候補あり/なし）: ${sc.codes.map((_, id) => `${id}:${tally.get(`${pal}|${sc.name}|miss${id}|rej`)?.n ?? 0}/${tally.get(`${pal}|${sc.name}|miss${id}|none`)?.n ?? 0}`).join(" ")}`);
      if (process.env.PERID) console.log(`R   ID ごと: ${sc.codes.map((_, id) => tally.get(`${pal}|${sc.name}|id${id}`)).map((x, id) => (x ? `${id}:${pct(x.ok, x.n)}` : "")).join(" ")}`);
    }
    console.log(`R == 配色: ${pal}（全条件）==`);
    for (const sc of schemes) {
      const t = tally.get(`${pal}|${sc.name}`)!;
      const by = (p: string, vals: number[]) => vals.map((v) => pct(tally.get(`${pal}|${sc.name}|${p}${v}`)!.ok, tally.get(`${pal}|${sc.name}|${p}${v}`)!.n)).join(" ");
      console.log(`R ${sc.name}: 正 ${pct(t.ok, t.n)} 誤読 ${pct(t.wrong, t.n)}（${t.wrong}、うち同じ色 ${t.sameColor}）余分 ${t.extra} | 大きさ ${sizes.join("/")}px: ${by("s", sizes)} | 傾き 0/55/70°: ${by("k", tilts)} | ぶれ 0/5/10/20%: ${by("b", blurs)}`);
    }
  }
}, 3600000);

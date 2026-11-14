// 専用のマーカー検出（src/aruco/quadDetect.ts。OpenCV を使わない）: 二値化の WASM と JS が同じ結果になること、合成のキューブで
// OpenCV の検出と同じかそれ以上のマーカーが、違う ID なしで読めること
import { beforeAll, describe, expect, it } from "vitest";
import { markerBits } from "../src/aruco/codes";
import { ArucoBench, DEFAULT_CONFIGS, measureCells } from "../src/aruco/detect";
import { STICKERS, designOf } from "../src/aruco/design";
import { QuadDetector, makeThresholder } from "../src/aruco/quadDetect";
import { type Vec3, parseMoves } from "../src/cube/model";
import type { CV } from "../src/vision/image";
import { applyMoveStickers, renderArucoCube, solvedStickers, stickerAt } from "./arucoCube";
import { loadTestOpenCv } from "./cv";
import { rng } from "./sim";

let cv: CV;
beforeAll(async () => {
  cv = await loadTestOpenCv();
}, 120000);

const design = designOf(STICKERS.arucoDesign);

function scene(alg: string, eye: Vec3, w = 1280, h = 720, noise = 2.5) {
  let st = solvedStickers();
  for (const m of parseMoves(alg)) st = applyMoveStickers(st, m);
  const truth: { id: number; corners: number[] }[] = [];
  return { st, truth, img: renderArucoCube(cv, { width: w, height: h, stickers: st, orient: 0, eye, noise, seed: 7, scheme: "unique54", design, truth }) };
}

// 検出したマーカーの四隅の、本当の四隅からの距離（同じ ID のいちばん近いマーカーと、角ごとにいちばん近い角）
function cornerErrors(ms: { id: number; corners: number[] }[], truth: { id: number; corners: number[] }[]): number[] {
  const out: number[] = [];
  for (const m of ms) {
    const cx = (m.corners[0] + m.corners[2] + m.corners[4] + m.corners[6]) / 4;
    const cy = (m.corners[1] + m.corners[3] + m.corners[5] + m.corners[7]) / 4;
    let best: number[] | null = null;
    let bd = 1e9;
    for (const t of truth) {
      if (t.id !== m.id) continue;
      const d = Math.hypot((t.corners[0] + t.corners[2] + t.corners[4] + t.corners[6]) / 4 - cx, (t.corners[1] + t.corners[3] + t.corners[5] + t.corners[7]) / 4 - cy);
      if (d < bd) { bd = d; best = t.corners; }
    }
    if (!best) continue;
    for (let k = 0; k < 4; k++) {
      let e = 1e9;
      for (let j = 0; j < 4; j++) e = Math.min(e, Math.hypot(best[j * 2] - m.corners[k * 2], best[j * 2 + 1] - m.corners[k * 2 + 1]));
      out.push(e);
    }
  }
  return out.sort((a, b) => a - b);
}
const pct = (v: number[], q: number) => v[Math.min(v.length - 1, Math.floor(v.length * q))] ?? 0;

describe("二値化: WASM と JS", () => {
  it("同じビット列になる（画像の幅までのビット）", () => {
    const wasm = makeThresholder();
    const js = makeThresholder(true);
    if (!wasm.simd) return; // SIMD のない環境では JS だけ
    const rnd = rng(3);
    for (const [w, h] of [
      [500, 300],
      [641, 333],
      [64, 40],
      [1280, 96],
    ]) {
      const a = wasm.layout(w, h);
      const b = js.layout(w, h);
      expect(wasm.vs).toBe(js.vs);
      expect(wasm.stride).toBe(js.stride);
      // ぼけた模様 + 雑音（明るさが 0〜255 の全部を通る）
      for (let y = 0; y < h; y++)
        for (let x = 0; x < wasm.vs; x++) {
          const v = x < w ? Math.max(0, Math.min(255, Math.round(128 + 120 * Math.sin(x / 5.3) * Math.cos(y / 4.1) + 40 * (rnd() - 0.5)))) : 0;
          a[y * wasm.vs + x] = v;
          b[y * js.vs + x] = v;
        }
      for (const win of [3, 5, 11, 15]) {
        const p = wasm.run(win, 7);
        const q = js.run(win, 7);
        const sw = wasm.stride >> 2;
        let diff = 0;
        let ones = 0;
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const pa = (p[y * sw + (x >> 5)] >>> (x & 31)) & 1;
            const qa = (q[y * sw + (x >> 5)] >>> (x & 31)) & 1;
            if (pa !== qa) diff++;
            ones += qa;
          }
        expect(diff).toBe(0);
        expect(ones).toBeGreaterThan(w * h * 0.1);
      }
    }
  });

  it("明るさ max(R, G, B) も同じ（切り出し・幅の余り・画像の幅いっぱい）", () => {
    const wasm = makeThresholder();
    expect(wasm.simd).toBe(true);
    const r = rng(7);
    const W = 203;
    const H = 61;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < data.length; i++) data[i] = Math.floor(r() * 256);
    const img = { data, width: W, height: H };
    for (const reg of [
      { x: 0, y: 0, w: W, h: H },
      { x: 5, y: 3, w: 37, h: 20 },
      { x: 17, y: 9, w: 150, h: 50 },
      { x: 0, y: 10, w: W, h: 7 },
    ]) {
      const v = wasm.layout(reg.w, reg.h);
      v.fill(77);
      expect(wasm.fillMax!(img, reg)).toBe(true);
      const out = wasm.layout(reg.w, reg.h);
      for (let y = 0; y < reg.h; y++)
        for (let x = 0; x < wasm.vs; x++) {
          const i = ((reg.y + y) * W + reg.x + x) * 4;
          const want = x < reg.w ? Math.max(data[i], data[i + 1], data[i + 2]) : 0;
          if (out[y * wasm.vs + x] !== want) throw new Error(`(${x},${y}) ${out[y * wasm.vs + x]} != ${want}`);
        }
    }
  });

  it("検出の結果も同じ", () => {
    const { img } = scene("R U F' D2 L", [2.4, 2.4, 5.5]);
    const a = new QuadDetector("unique54").detect(img);
    const b = new QuadDetector("unique54", { forceJs: true }).detect(img);
    expect(a.map((m) => `${m.id}:${m.corners.join(",")}`).sort()).toEqual(b.map((m) => `${m.id}:${m.corners.join(",")}`).sort());
    expect(a.length).toBeGreaterThan(40);
  });
});

describe("マーカーの測り方", () => {
  it("OpenCV の経路（measureCells）と同じ値", () => {
    const { img } = scene("R U F' D2 L", [2.4, 2.4, 5.5]);
    const ms = new QuadDetector("unique54").detect(img);
    expect(ms.length).toBeGreaterThan(40);
    for (const m of ms) {
      const pts = [0, 1, 2, 3].map((k) => [m.corners[k * 2], m.corners[k * 2 + 1]] as [number, number]);
      const ref = measureCells(img, pts, markerBits("unique54", m.id), 5);
      expect(m.rgb).toEqual(ref.rgb);
      expect(m.contrastMax).toBe(ref.contrastMax);
      expect(m.contrastGray).toBe(ref.contrastGray);
      expect(m.fit).toBeCloseTo(ref.fit, 6);
    }
  });
});

describe("専用の検出と OpenCV", () => {
  const views: { alg: string; eye: Vec3 }[] = [
    { alg: "R U F' D2 L", eye: [2.4, 2.4, 5.5] },
    { alg: "F2 U' R B", eye: [3, 2.6, 8.5] },
    { alg: "L D R' U2 F", eye: [4.2, 2, 4.8] },
    { alg: "U R2 F B'", eye: [1.8, 1.2, 6.5] },
  ];

  it("OpenCV と同じかそれ以上のマーカーを読み、見えていないステッカーの ID は出さない", () => {
    const bench = new ArucoBench(cv, [DEFAULT_CONFIGS[1]], "unique54", design);
    const quad = new QuadDetector("unique54");
    let nCv = 0;
    let nQuad = 0;
    const diffs: number[] = [];
    const errCv: number[] = [];
    const errQuad: number[] = [];
    let false_ = 0;
    for (const v of views) {
      const { st, img, truth } = scene(v.alg, v.eye);
      const a = bench.detect(img)[0].markers;
      const b = quad.detect(img);
      errCv.push(...cornerErrors(a, truth));
      errQuad.push(...cornerErrors(b, truth));
      nCv += a.length;
      nQuad += b.length;
      const sides = a.map((m) => m.side).sort((p, q) => p - q);
      console.log(`  ${v.eye.join(",")}: OpenCV ${a.length}・専用 ${b.length}・辺 ${sides[0]?.toFixed(1)}〜${sides[sides.length - 1]?.toFixed(1)}`);
      // 見えている面（上・右・正面）にあるステッカーだけ
      const visible = new Set<number>();
      const at = stickerAt(st);
      for (const face of [0, 1, 2]) for (let cell = 0; cell < 9; cell++) visible.add(at[face * 9 + cell]);
      const bad = b.filter((m) => !visible.has(m.id));
      const count = (ms: { id: number }[]) => { const c = new Map<number, number>(); for (const m of ms) c.set(m.id, (c.get(m.id) ?? 0) + 1); return c; };
      const ca = count(a), cb = count(b);
      console.log(`  違う ID ${bad.map((m) => `${m.id}(辺 ${m.side.toFixed(0)} fit ${m.fit.toFixed(2)})`).join(" ")}・OpenCV の違う ID ${a.filter((m) => !visible.has(m.id)).length}・ステッカーごとの数 OpenCV ${[...ca].map(([k, n]) => `${k}:${n}`).join(" ")} | 専用 ${[...cb].map(([k, n]) => `${k}:${n}`).join(" ")}`);
      false_ += bad.length;
      // 同じマーカーは角もほぼ同じ（1 画素ほど）
      for (const m of b) {
        const cx = (m.corners[0] + m.corners[4]) / 2;
        const cy = (m.corners[1] + m.corners[5]) / 2;
        const o = a.find((x) => x.id === m.id && Math.hypot((x.corners[0] + x.corners[4]) / 2 - cx, (x.corners[1] + x.corners[5]) / 2 - cy) < m.side * 0.4);
        if (!o) continue;
        for (let k = 0; k < 8; k++) diffs.push(Math.abs(o.corners[k] - m.corners[k]));
      }
    }
    diffs.sort((p, q) => p - q);
    console.log(`マーカー: OpenCV ${nCv}・専用 ${nQuad}・角の差 中央 ${diffs[diffs.length >> 1]}・95% ${diffs[Math.floor(diffs.length * 0.95)]}・最大 ${diffs[diffs.length - 1]}・1.5 より大 ${diffs.filter((d) => d > 1.5).length}/${diffs.length}`);
    errCv.sort((p, q) => p - q);
    errQuad.sort((p, q) => p - q);
    const mean = (e: number[]) => e.reduce((p, q) => p + q, 0) / e.length;
    console.log(`本当の角からの距離（平均・中央・90%・99%・最大）: OpenCV ${mean(errCv).toFixed(2)} ${pct(errCv, 0.5).toFixed(2)} ${pct(errCv, 0.9).toFixed(2)} ${pct(errCv, 0.99).toFixed(2)} ${pct(errCv, 1).toFixed(2)}・専用 ${mean(errQuad).toFixed(2)} ${pct(errQuad, 0.5).toFixed(2)} ${pct(errQuad, 0.9).toFixed(2)} ${pct(errQuad, 0.99).toFixed(2)} ${pct(errQuad, 1).toFixed(2)}`);
    // 角は本当の位置に OpenCV と同じくらい近い
    expect(mean(errQuad)).toBeLessThanOrEqual(mean(errCv) * 1.05);
    expect(pct(errQuad, 0.9)).toBeLessThanOrEqual(pct(errCv, 0.9) * 1.05 + 0.05);
    expect(false_).toBe(0);
    expect(nQuad).toBeGreaterThanOrEqual(nCv * 0.97);
    bench.delete();
  });

  it("切り出して検出しても、画像全体と同じマーカー（切り出しの縁から離れたもの）", () => {
    const { img } = scene("R U F' D2 L", [2.4, 2.4, 5.5]);
    const quad = new QuadDetector("unique54");
    const all = quad.detect(img);
    const xs = all.flatMap((m) => [m.corners[0], m.corners[2], m.corners[4], m.corners[6]]);
    const ys = all.flatMap((m) => [m.corners[1], m.corners[3], m.corners[5], m.corners[7]]);
    const r = { x: Math.floor(Math.min(...xs)) - 40, y: Math.floor(Math.min(...ys)) - 40, w: 0, h: 0 };
    r.w = Math.ceil(Math.max(...xs)) + 40 - r.x;
    r.h = Math.ceil(Math.max(...ys)) + 40 - r.y;
    const part = quad.detect(img, r);
    const key = (m: { id: number; corners: number[] }) => `${m.id}:${Math.round(m.corners[0] / 3)}:${Math.round(m.corners[1] / 3)}`;
    const got = new Set(part.map(key));
    const missing = all.filter((m) => !got.has(key(m)));
    expect(missing.length).toBeLessThanOrEqual(1);
    expect(part.length).toBeGreaterThanOrEqual(all.length - 1);
  });
});

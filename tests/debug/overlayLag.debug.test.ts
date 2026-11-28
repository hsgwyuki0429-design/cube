// 読み取りの図（src/ui/CameraView.tsx）の遅れ: 認識の結果は撮影から遅れて届く（perfLog の drawLag。偽のカメラの E2E で中央 36〜67ms・
// 90% 80〜105ms）ので、図は映像より前の位置に描かれる。実機のライブの記録の面の外枠（sight.quad）で、遅れ L のときの図の外枠と、その時刻の
// 本当の外枠（前後の読みの間を直線でつなぐ）のずれ（4 隅の平均、画素）を出し、先読み（前の 2 回の外枠から L だけ先へ進める）の効きを比べる。
//   OL_LIVE=ライブの記録（.json.gz）[OL_LAGS=36,50,67,100]
//   npx vitest run -c vitest.debug.config.ts tests/debug/overlayLag.debug.test.ts --silent=false
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { it } from "vitest";
import type { SightFrame } from "../../src/track/sight";

interface Q {
  t: number;
  q: number[];
}

const centerOf = (f: { ids: number[] }) => f.ids[4];
const dist = (a: number[], b: number[]) => {
  let s = 0;
  for (let i = 0; i < 4; i++) s += Math.hypot(a[2 * i] - b[2 * i], a[2 * i + 1] - b[2 * i + 1]);
  return s / 4;
};
const pct = (xs: number[], p: number) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : Number.NaN;
};

it("読み取りの図の遅れと先読み", () => {
  const file = process.env.OL_LIVE;
  if (!file) return;
  const live = JSON.parse(gunzipSync(readFileSync(file)).toString());
  const lags = (process.env.OL_LAGS ?? "36,50,67,100").split(",").map(Number);
  const startT: number = live.timer.startT;
  const endT: number = startT + (live.solves?.[0]?.provisionalMs ?? live.solves?.[0]?.timeMs ?? 0);
  let inspect = startT - 5000;
  for (const e of live.log.segments[0].events) if (e.kind === "options" && e.data?.snapToView === true && e.t < startT) inspect = e.t;
  const sights: SightFrame[] = live.log.segments.flatMap((s: { readings: { sight?: SightFrame }[] }) => s.readings.map((r) => r.sight).filter(Boolean));
  // 面ごと（センターの ID で同じ面とみなす。センターが読めない面は使わない）の外枠の列
  const tracks = new Map<number, Q[]>();
  for (const s of sights)
    for (const f of s.faces) {
      if (f.held || centerOf(f) < 0 || !f.quad) continue;
      const k = centerOf(f);
      if (!tracks.has(k)) tracks.set(k, []);
      tracks.get(k)!.push({ t: s.t, q: f.quad });
    }
  const phases = [
    { name: "崩し", from: -Infinity, to: inspect },
    { name: "インスペクション", from: inspect, to: startT },
    { name: "ソルブ", from: startT, to: endT },
  ];
  for (const L of lags) {
    const rows: Record<string, { none: number[]; lin: number[]; half: number[] }> = {};
    for (const p of phases) rows[p.name] = { none: [], lin: [], half: [] };
    for (const tr of tracks.values()) {
      for (let i = 1; i < tr.length; i++) {
        const cur = tr[i];
        const prev = tr[i - 1];
        const T = cur.t + L;
        // 本当の外枠: T をはさむ読み（間が 60ms まで）を直線でつなぐ
        let j = i;
        while (j + 1 < tr.length && tr[j + 1].t < T) j++;
        const a = tr[j];
        const b = tr[j + 1];
        if (!b || b.t - a.t > 60 || a.t > T) continue;
        const u = (T - a.t) / (b.t - a.t);
        const truth = a.q.map((v, k) => v + (b.q[k] - v) * u);
        const ph = phases.find((p) => cur.t >= p.from && cur.t < p.to);
        if (!ph) continue;
        const dt = cur.t - prev.t;
        const lin = dt > 0 && dt <= 60 ? cur.q.map((v, k) => v + ((v - prev.q[k]) * Math.min(L, 2 * dt)) / dt) : cur.q;
        const half = cur.q.map((v, k) => v + (lin[k] - v) * 0.5);
        rows[ph.name].none.push(dist(cur.q, truth));
        rows[ph.name].lin.push(dist(lin, truth));
        rows[ph.name].half.push(dist(half, truth));
      }
    }
    console.log(`遅れ ${L}ms:`);
    for (const p of phases) {
      const r = rows[p.name];
      if (!r.none.length) continue;
      const f = (xs: number[]) => `中央 ${pct(xs, 0.5).toFixed(1)}・90% ${pct(xs, 0.9).toFixed(1)}`;
      console.log(`  ${p.name}（${r.none.length}）: そのまま ${f(r.none)} | 先読み ${f(r.lin)} | 半分だけ先読み ${f(r.half)}（px、長辺 1280）`);
    }
  }
});

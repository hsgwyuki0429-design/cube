// 撮り方の物差し（src/vision/captureMetrics.ts・撮り方の案内 src/app/captureAdvice.ts のしきい値を決める）を、実機の書き出しで場面ごとに出す。
//   CS_LIVE=ライブの記録（.json.gz）[CS_REC=同じソルブの録画の書き出し]（明るさは録画の画素から）
//   npx vitest run -c vitest.debug.config.ts tests/debug/captureStats.debug.test.ts --silent=false
// 録画だけ（CS_REC。ライブの記録なし）のときは、録画を本体のライブの認識の設定で読んで見え方を作る（遅い）
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { it } from "vitest";
import { brightness, viewMetrics } from "../../src/vision/captureMetrics";
import type { SightFrame } from "../../src/track/sight";
import { loadExport, readExportFrames } from "./lib/recording";
import { solveStatsOf } from "../../src/app/captureAdvice";

const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : Number.NaN);
const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "-");

it("撮り方の物差し", async () => {
  const liveFile = process.env.CS_LIVE;
  const recFile = process.env.CS_REC;
  if (!liveFile) return;
  const live = JSON.parse(gunzipSync(readFileSync(liveFile)).toString());
  const W = 1280;
  const H = 720;
  const readings: { t: number; sight?: SightFrame; faces: { ids?: number[] }[] }[] = live.log.segments.flatMap((s: { readings: unknown[] }) => s.readings);
  const meta = recFile ? loadExport(recFile) : null;
  const startT: number = meta?.analysis.live?.startT ?? live.timer.startT;
  const endT: number = meta?.analysis.live?.endT ?? startT + (live.solves?.[0]?.provisionalMs ?? 0);
  let inspect = startT - 5000;
  for (const e of live.log.segments[0].events) if (e.kind === "options" && e.data?.snapToView === true && e.t < startT) inspect = e.t;
  const phases = [
    { name: "崩し", from: -Infinity, to: inspect },
    { name: "インスペクション", from: inspect, to: startT },
    { name: "ソルブ", from: startT, to: endT },
    { name: "止めた後", from: endT, to: Infinity },
  ];
  for (const p of phases) {
    const rs = readings.filter((r) => r.t >= p.from && r.t < p.to);
    if (!rs.length) continue;
    const ms = rs.map((r) => viewMetrics(r.sight, W, H));
    const withFace = ms.filter((m) => m.faces > 0);
    const cells = rs.map((r) => r.faces.reduce((n, fc) => n + (fc.ids ?? []).filter((id) => id >= 0).length, 0));
    console.log(
      `${p.name}（${rs.length} 枚）: 面なし ${f((1 - withFace.length / ms.length) * 100, 0)}%・2 面以上 ${f((ms.filter((m) => m.faces >= 2).length / ms.length) * 100, 0)}%・1 フレームのマス ${f(cells.reduce((a, b) => a + b, 0) / rs.length, 2)}` +
        ` | 面の辺 中央 ${f(med(withFace.map((m) => m.faceEdge)), 0)}px（マーカー ≈ ${f(med(withFace.map((m) => m.faceEdge)) * 0.133, 0)}px）・囲み ${f(med(withFace.map((m) => m.box!.x1 - m.box!.x0)), 0)}×${f(med(withFace.map((m) => m.box!.y1 - m.box!.y0)), 0)}px` +
        ` | 真ん中から ${f(med(withFace.map((m) => m.cx)), 2)},${f(med(withFace.map((m) => m.cy)), 2)}・端にかかる ${f((withFace.filter((m) => m.edge).length / Math.max(1, withFace.length)) * 100, 0)}%・正面の縮み 中央 ${f(med(withFace.map((m) => m.frontCos)), 2)}`,
    );
  }
  const solveRs = readings.filter((r) => r.t >= startT && r.t < endT);
  const ss = solveStatsOf(solveRs.map((r) => ({ t: r.t, view: viewMetrics(r.sight, W, H), cells: r.faces.reduce((n, fc) => n + (fc.ids ?? []).filter((id) => id >= 0).length, 0) })));
  console.log(`ソルブの数字（案内に使う）: ${JSON.stringify(ss)}`);
  if (!meta || !recFile) return;
  // 明るさ: 録画のフレーム（6 枚に 1 枚）を、いちばん近いライブの読みの面の囲みで
  const rows: { t: number; cube: number; frame: number }[] = [];
  let j = 0;
  await readExportFrames(recFile, meta, (img, tUs, k) => {
    if (k % 6) return;
    const t = tUs / 1000;
    while (j + 1 < readings.length && Math.abs(readings[j + 1].t - t) <= Math.abs(readings[j].t - t)) j++;
    const r = readings[j];
    if (!r || Math.abs(r.t - t) > 20) return;
    const m = viewMetrics(r.sight, img.width, img.height);
    rows.push({ t, ...brightness(img, m.box) });
  });
  for (const p of phases) {
    const xs = rows.filter((r) => r.t >= p.from && r.t < p.to);
    if (xs.length) console.log(`明るさ ${p.name}（${xs.length} 枚）: キューブの周り 中央 ${f(med(xs.map((x) => x.cube)), 0)}・画面全体 ${f(med(xs.map((x) => x.frame)), 0)}（max(R,G,B) の平均、0〜255）`);
  }
}, 600000);

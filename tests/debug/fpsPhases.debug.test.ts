// ソルブの場面ごと（崩し・インスペクション・ソルブ・止めた後）の fps と、ライブ・録画・精密解析がそれぞれ何枚扱ったかを並べる
// （ライブ 2.5: ソルブ中に fps が落ちる原因を調べる）。実機の書き出しをそのまま読む:
//   FPS_LIVE=ライブの記録（cubevision-live-….json.gz）・FPS_REC=同じソルブの録画の書き出し（cubevision-rec-….mp4）（どちらか片方でもよい）
//   npx vitest run -c vitest.debug.config.ts tests/debug/fpsPhases.debug.test.ts --silent=false
// 書き出しに 1 秒ごとの計測（perf: src/app/perfLog.ts。2026-11-27 から）があれば、場面ごとの平均も出す
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { it } from "vitest";
import { exportTimesUs, loadExport } from "./lib/recording";
import { type PerfRow, summarizePerf } from "../../src/app/perfLog";

interface Phase {
  name: string;
  from: number;
  to: number;
}

const fmt = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "-");

it("場面ごとの fps", () => {
  const liveFile = process.env.FPS_LIVE;
  const recFile = process.env.FPS_REC;
  if (!liveFile && !recFile) return;
  const live = liveFile ? JSON.parse(gunzipSync(readFileSync(liveFile)).toString()) : null;
  const meta = recFile ? loadExport(recFile) : null;
  // 場面の境: 作り変えを始めた設定の変更（インスペクションの始まり）・ソルブの始まり・止めた時刻・解析が終わった（ライブを休み終えた）
  const startT: number | undefined = meta?.analysis.live?.startT ?? live?.timer?.startT;
  const endT: number | undefined = meta?.analysis.live?.endT ?? (live && startT !== undefined ? startT + (live.solves?.[0]?.provisionalMs ?? live.solves?.[0]?.timeMs ?? 0) : undefined);
  let inspect: number | undefined = meta?.analysis.input.from;
  if (live && startT !== undefined) for (const e of live.log.segments[0].events) if (e.kind === "options" && e.data?.snapToView === true && e.t < startT) inspect = e.t;
  const recTimes = meta && recFile ? exportTimesUs(recFile, meta).map((u) => u / 1000) : [];
  const readings: { t: number; helper?: boolean; procMs: number; faces: unknown[] }[] = live ? live.log.segments.flatMap((s: { readings: unknown[] }) => s.readings) : [];
  const lastT = Math.max(recTimes[recTimes.length - 1] ?? 0, readings[readings.length - 1]?.t ?? 0);
  const firstT = Math.min(recTimes[0] ?? Infinity, readings[0]?.t ?? Infinity);
  const phases: Phase[] = [];
  if (inspect !== undefined && startT !== undefined && endT !== undefined) {
    phases.push({ name: "崩し（記録の始まり〜）", from: firstT, to: inspect });
    phases.push({ name: "インスペクション", from: inspect, to: startT });
    phases.push({ name: "ソルブ", from: startT, to: endT });
    phases.push({ name: "止めた後 3 秒", from: endT, to: endT + 3000 });
    phases.push({ name: "止めた後 3〜10 秒", from: endT + 3000, to: endT + 10000 });
    phases.push({ name: "止めた後 10 秒〜", from: endT + 10000, to: lastT });
  } else phases.push({ name: "全部", from: firstT, to: lastT });
  console.log(`インスペクション ${fmt((inspect ?? NaN) / 1000, 2)}s・ソルブ ${fmt((startT ?? NaN) / 1000, 2)}〜${fmt((endT ?? NaN) / 1000, 2)}s`);
  const st = meta?.analysis.result?.decodeInfo?.stream;
  if (st && startT !== undefined && endT !== undefined) {
    // 精密解析の Worker の遅れ: 回し始めの知らせ・止めた知らせが届いたときに処理していたフレームの時刻（届いた時刻 ≒ ライブが決めた時刻）
    console.log(`精密解析の遅れ: 回し始めの知らせのとき ${fmt((startT - (st.solvingAt ?? NaN)) / 1000, 2)} 秒（インスペクションはわざと 3 秒遅らせる）・止めた知らせのとき ${fmt((endT - (st.endAt ?? NaN)) / 1000, 2)} 秒・処理 ${meta?.analysis.result?.decodeInfo?.refined} 枚 / 復号 ${meta?.analysis.result?.decodeInfo?.decoded} 枚`);
  }
  for (const p of phases) {
    const sec = Math.max(0.001, (p.to - p.from) / 1000);
    const rec = recTimes.filter((t) => t >= p.from && t < p.to);
    const gaps = rec.slice(1).map((t, i) => t - rec[i]);
    const holes = gaps.filter((g) => g > 25).length;
    const rs = readings.filter((r) => r.t >= p.from && r.t < p.to);
    const main = rs.filter((r) => !r.helper);
    const help = rs.filter((r) => r.helper);
    const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
    // 認識の Worker の忙しさの目安: 処理した枚数 × 1 枚の時間 ÷ 長さ（主の Worker は追跡の分を含まない）
    const busy = (xs: typeof rs) => xs.reduce((s, r) => s + r.procMs, 0) / (sec * 1000);
    console.log(
      `${p.name}（${fmt(sec)} 秒）: 録画 ${rec.length ? `${fmt(rec.length / sec)}fps・抜け ${holes}` : "-"}` +
        ` | ライブ ${rs.length ? `${fmt(rs.length / sec)} 枚/秒（主 ${fmt(main.length / sec)}・補助 ${fmt(help.length / sec)}）・認識 中央 主 ${fmt(med(main.map((r) => r.procMs)))}ms 補助 ${fmt(med(help.map((r) => r.procMs)))}ms・忙しさ 主 ${fmt(busy(main) * 100, 0)}% 補助 ${fmt(busy(help) * 100, 0)}%` : "-"}`,
    );
  }
  const perf: PerfRow[] = meta?.perf ?? live?.perf ?? [];
  if (perf.length) for (const p of phases) console.log(`  ${p.name}: ${summarizePerf(perf.filter((r) => r.t >= p.from && r.t < p.to))}`);
});

// 端から端までのテスト: ビルド済みアプリをヘッドレス Chromium で開き、デモモード（合成カメラ）で
// 「6面スキャン → 指定手数を回す」を実行して、追跡した手順を正解と比較する。
//
//   npm run build && npm run e2e            # 既定: 2面が見える位置・2TPS・30手
//   E2E_VIEW=corner E2E_TPS=3 npm run e2e
//   E2E_STICKERS=aruco12 npm run e2e      # ステッカーの符号（既定 unique54。aruco12・aruco = 4×4 の 54 種類。E2E_MODE=timer も可）
//   E2E_DESIGN=quad-half npm run e2e       # マーカーの配置（既定 standard）
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

import { createServer } from "node:net";

// 空いているポートを使う（前回のサーバーがポートを離すまでの待ちを避ける）
const PORT = Number(process.env.E2E_PORT) || (await new Promise((resolve) => {
  const srv = createServer();
  srv.listen(0, () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
}));
const VIEW = process.env.E2E_VIEW ?? "top";
const TPS = Number(process.env.E2E_TPS ?? 2);
const MOVES = Number(process.env.E2E_MOVES ?? 30);
const SEEDS = (process.env.E2E_SEEDS ?? "11").split(",").map(Number);
const OUT = process.env.E2E_OUT ?? "e2e-output";
const MODE = process.env.E2E_MODE ?? "track"; // track | timer
const STICKERS = process.env.E2E_STICKERS ?? "unique54"; // unique54 | aruco12 | aruco（合成キューブに描くマーカーの符号）
const DESIGN = process.env.E2E_DESIGN ?? "standard"; // standard | quad-half（ステッカーの中のマーカーの配置）
const CHROME = process.env.CHROME_PATH ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

if (!existsSync("dist/index.html")) {
  console.error("dist/ がありません。先に npm run build を実行してください。");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "pipe" });
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => String(d).includes(String(PORT)) && resolve());
  server.on("exit", (c) => reject(new Error(`preview exited ${c}`)));
  setTimeout(resolve, 8000);
});

const FACE = ["U", "R", "F", "D", "L", "B"];
const name = (m) => FACE[Math.floor(m / 3)] + ["", "2", "'"][m % 3];
const OPP = [3, 4, 5, 0, 1, 2];
function canonical(moves) {
  const out = [];
  for (const m of moves) {
    const last = out[out.length - 1];
    if (last !== undefined && Math.floor(last / 3) === Math.floor(m / 3)) {
      const amt = ((last % 3) + 1 + (m % 3) + 1) % 4;
      out.pop();
      if (amt) out.push(Math.floor(m / 3) * 3 + amt - 1);
      continue;
    }
    out.push(m);
  }
  for (let p = 0; p < out.length; p++)
    for (let i = 0; i + 1 < out.length; i++) {
      const a = Math.floor(out[i] / 3);
      const b = Math.floor(out[i + 1] / 3);
      if (OPP[a] === b && a > b) [out[i], out[i + 1]] = [out[i + 1], out[i]];
    }
  return out;
}
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required", "--ignore-gpu-blocklist"],
});
let failures = 0;
const results = [];
try {
  for (const seed of SEEDS) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const logs = [];
    page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
    const t0 = Date.now();
    await page.goto(`http://localhost:${PORT}/?demo=e2e&seed=${seed}&moves=${MOVES}&tps=${TPS}&view=${VIEW}${MODE === "timer" ? "&timer=1" : ""}&stickers=${STICKERS}&design=${DESIGN}`);
    if (MODE === "timer") {
      try {
        await page.waitForFunction(() => window.__cubevisionTimer?.get().phase === "done", null, { timeout: 240000, polling: 500 });
      } catch (e) {
        const st = await page.evaluate(() => {
          const t = window.__cubevisionTimer.get();
          const tr = window.__cubevision.store.get();
          return { phase: t.phase, guide: t.guide.length, guideDone: t.guideDone, recomputing: t.recomputing, status: tr.track?.status, moves: tr.track?.moves.length, truth: window.__cubevision.synthetic?.truth.length, stats: tr.stats, scan: !!tr.scan };
        });
        console.log(`seed ${seed} timer: TIMEOUT ${JSON.stringify(st)}`);
        await page.screenshot({ path: `${OUT}/seed${seed}-timer-timeout.png` });
        console.log(logs.slice(-20).join("\n"));
        failures++;
        results.push({ seed, acc: 0, finalOk: false, scanSec: 0 });
        await page.close();
        continue;
      }
      await page.screenshot({ path: `${OUT}/seed${seed}-timer-done.png` });
      const live = await page.evaluate(() => window.__cubevisionTimer.get().result);
      // 録画の精密解析が終わるまで待つ
      await page.waitForFunction(() => window.__cubevisionTimer.get().result?.analysis !== "pending", null, { timeout: 240000, polling: 500 }).catch(() => undefined);
      await page.screenshot({ path: `${OUT}/seed${seed}-timer-analyzed.png` });
      const r = await page.evaluate(() => {
        const t = window.__cubevisionTimer.get();
        const syn = window.__cubevision.synthetic;
        return { result: t.result, solves: t.solves.length, solved: window.__cubevision.store.get().track?.solved, truth: syn ? syn.truth.slice(syn.solveFrom).map((x) => ({ ...x })) : [] };
      });
      // 正解: 解き始め（インスペクション後の最初の手）から最後の手まで
      const n = r.result?.moves.length ?? 0;
      const sol = r.truth;
      const truthMs = sol.length ? sol[sol.length - 1].t - sol[0].start : NaN;
      const ok = r.result && r.result.tracked && r.solved && r.result.timeMs > 0 && n > 5;
      const analysisOk = r.result?.analysis === "done" || process.env.E2E_ALLOW_NO_ANALYSIS;
      console.log(
        `seed ${seed} timer: ${ok ? "OK" : "NG"} live ${(live?.timeMs / 1000).toFixed(3)}s → ${r.result?.analysis} ${(r.result?.timeMs / 1000).toFixed(3)}s (truth ≈ ${(truthMs / 1000).toFixed(3)}s, ${sol.length} moves) moves ${n} tps ${r.result?.tps.toFixed(2)} splits ${JSON.stringify(r.result?.splits?.map((x) => [x.name, x.moves]))}`,
      );
      if (process.env.E2E_VERBOSE) {
        const t0 = sol[0]?.start ?? 0;
        console.log(`  truth : ${sol.map((x) => `${name(x.move)}@${Math.round(x.start - t0)}-${Math.round(x.t - t0)}`).join(" ")}`);
        console.log(`  result: ${(r.result?.moves ?? []).map((x) => `${x.m}${x.inferred ? "?" : ""}@${x.s}-${x.t}`).join(" ")}`);
        console.log(`  live  : ${(live?.moves ?? []).map((x) => `${x.m}@${x.s}-${x.t}`).join(" ")}`);
        const dbg = await page.evaluate(() => window.__cubevisionAnalysis);
        const raw = dbg?.result;
        if (raw) {
          const b = raw.start;
          console.log(`  raw   : ${raw.raw.map((x) => `${name(x.move)}${x.inferred ? "?" : ""}[${Math.round(x.t0 - b)},${Math.round(x.t - b)}]@${Math.round(x.start - b)}-${Math.round(x.end - b)}`).join(" ")}`);
          console.log(`  frames ${raw.frames} status ${raw.status} forced ${raw.forced} recording ${JSON.stringify(dbg.recording)} stats ${JSON.stringify(await page.evaluate(() => window.__cubevision.store.get().stats))}`);
        }
      }
      results.push({ seed, acc: ok && analysisOk ? 1 : 0, finalOk: !!ok, scanSec: 0 });
      if (ok && !analysisOk) {
        failures++;
        console.log(logs.slice(-30).join("\n"));
      }
      if (!ok) {
        failures++;
        console.log(logs.slice(-30).join("\n"));
      }
      await page.close();
      continue;
    }
    // スキャン完了（追跡開始）まで
    await page.waitForFunction(() => !!window.__cubevision?.store.get().cube, null, { timeout: 180000, polling: 500 });
    const scanSec = (Date.now() - t0) / 1000;
    await page.screenshot({ path: `${OUT}/seed${seed}-tracking-start.png` });
    // 正解の手数に達して、少し落ち着くまで
    await page.waitForFunction((n) => (window.__cubevision?.synthetic?.truth.length ?? 0) >= n, MOVES, { timeout: 60000 + (MOVES / TPS) * 4000, polling: 500 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${OUT}/seed${seed}-end.png` });
    // 円環図（フリーの画面の下の方）
    const ring = page.locator(".ring-view").first();
    if (await ring.count()) await ring.screenshot({ path: `${OUT}/seed${seed}-ring.png` });
    const r = await page.evaluate(() => {
      const app = window.__cubevision;
      const t = app.store.get().track;
      return {
        truth: app.synthetic.truth.map((x) => x.move),
        decoded: (t?.moves ?? []).map((m) => m.move),
        inferred: (t?.moves ?? []).filter((m) => m.inferred).length,
        status: t?.status,
        synthState: Array.from(app.synthetic.state),
        trackState: t?.state ?? [],
        trackOrient: t?.orient,
        synthOrient: app.synthetic.orient,
        observations: t?.observations,
        recoveries: t?.recoveries,
        stats: app.store.get().stats,
      };
    });
    const a = canonical(r.decoded);
    const b = canonical(r.truth);
    const acc = 1 - editDistance(a, b) / Math.max(1, b.length);
    const finalOk = r.synthState.join() === r.trackState.join();
    const orientOk = r.trackOrient === r.synthOrient;
    results.push({ seed, acc, finalOk, scanSec });
    console.log(`seed ${seed}: scan ${scanSec.toFixed(1)}s  accuracy ${(acc * 100).toFixed(1)}%  final ${finalOk ? "OK" : "NG"}  orient ${orientOk ? "OK" : `NG(${r.trackOrient}/${r.synthOrient})`}  status ${r.status}  obs ${r.observations}  recov ${r.recoveries}  inferred ${r.inferred}  camFps ${r.stats.camFps} procFps ${r.stats.procFps} procMs ${r.stats.procMs.toFixed(1)}`);
    console.log(`  truth  : ${r.truth.map(name).join(" ")}`);
    console.log(`  decoded: ${r.decoded.map(name).join(" ")}`);
    if (!finalOk || !orientOk || acc < 0.9) {
      failures++;
      console.log(logs.slice(-30).join("\n"));
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}
const mean = results.reduce((s, r) => s + r.acc, 0) / results.length;
console.log(`\nview=${VIEW} tps=${TPS} moves=${MOVES}: mean accuracy ${(mean * 100).toFixed(1)}%, final state OK ${results.filter((r) => r.finalOk).length}/${results.length}`);
process.exit(failures ? 1 : 0);

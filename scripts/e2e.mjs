// 端から端までのテスト: ビルド済みアプリをヘッドレス Chromium で開き、デモモード（合成カメラ）で
// 「6面スキャン → 指定手数を回す」を実行して、追跡した手順を正解と比較する。
//
//   npm run build && npm run e2e            # 既定: 2面が見える位置・2TPS・30手
//   E2E_VIEW=corner E2E_TPS=3 npm run e2e
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
    await page.goto(`http://localhost:${PORT}/?demo=e2e&seed=${seed}&moves=${MOVES}&tps=${TPS}&view=${VIEW}${MODE === "timer" ? "&timer=1" : ""}`);
    if (MODE === "timer") {
      await page.waitForFunction(() => window.__cubevisionTimer?.get().phase === "done", null, { timeout: 300000, polling: 500 });
      await page.screenshot({ path: `${OUT}/seed${seed}-timer-done.png` });
      const r = await page.evaluate(() => {
        const t = window.__cubevisionTimer.get();
        return { result: t.result, solves: t.solves.length, solved: window.__cubevision.store.get().track?.solved };
      });
      const ok = r.result && r.result.tracked && r.solved && r.result.timeMs > 0 && r.result.moves.length > 5;
      console.log(`seed ${seed} timer: ${ok ? "OK" : "NG"} time ${(r.result?.timeMs / 1000).toFixed(2)}s moves ${r.result?.moves.length} tps ${r.result?.tps.toFixed(2)} splits ${JSON.stringify(r.result?.splits?.map((x) => [x.name, x.moves]))}`);
      results.push({ seed, acc: ok ? 1 : 0, finalOk: !!ok, scanSec: 0 });
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

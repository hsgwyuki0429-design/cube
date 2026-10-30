// 動画ファイルの精密解析（タイマーの「スロー動画から記録」・フリーの「動画を解析」）の端から端までのテスト。
// ビルド済みのアプリを開き、ArUco（unique54・4 個・幅 1/2）のキューブの合成動画を読み込ませて、手順とタイムを確かめる。
//   npm run build && VIDEO_FREE=tperm.mp4 VIDEO_TIMER=timer.mp4 node scripts/video-e2e.mjs
// 動画は tests/debug/arucoCubeVideo.debug.test.ts で作る:
//   フリー: ARUCO_SCHEME=unique54 ARUCO_DESIGN=quad-half ARUCO_VIDEO=tperm.mp4（揃った状態から T-perm 2 回、240fps）
//   タイマー: ARUCO_SCHEME=unique54 ARUCO_DESIGN=quad-half ARUCO_START="R U F' L D2 B" ARUCO_ALG="B' D2 L' F U' R'" ARUCO_FILE_FPS=30 ARUCO_VIDEO=timer.mp4
//   （240fps で撮って 30fps の再生に書き出した動画。撮影した fps に 240 を入れて実際の時間に直す）
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "playwright-core";

const FREE = process.env.VIDEO_FREE;
const TIMER = process.env.VIDEO_TIMER;
const TPERM = "R U R' U' R' F R2 U' R' U' R U R' F'";
const TIMER_SCRAMBLE = process.env.VIDEO_SCRAMBLE ?? "R U F' L D2 B";
const TIMER_SOLUTION = process.env.VIDEO_SOLUTION ?? "B' D2 L' F U' R'";
// タイマーの動画の正しいタイム（合成動画: 1 手 18 フレーム中 17 フレームで回し、手の間 6 フレーム。240fps）
const TIMER_TRUTH_MS = Number(process.env.VIDEO_TRUTH_MS ?? ((5 * 23 + 17) / 240) * 1000);
const OUT = "e2e-output/video";
const CHROME = process.env.CHROME ?? "/opt/pw-browsers/chromium";
if (!existsSync("dist/index.html")) {
  console.error("dist/ がありません。先に npm run build を実行してください。");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
const PORT = await new Promise((resolve) => {
  const s = createServer();
  s.listen(0, () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "pipe" });
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => String(d).includes(String(PORT)) && resolve());
  server.on("exit", (c) => reject(new Error(`preview exited ${c}`)));
  setTimeout(resolve, 8000);
});

const browser = await chromium.launch({ executablePath: existsSync(CHROME) ? CHROME : undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
let failures = 0;
const norm = (s) => s.replace(/\?/g, "").trim().split(/\s+/).join(" ");

async function open() {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => !!window.__cubevision, null, { timeout: 60000 });
  // 揃った状態から（ArUco はスキャンなしで始められる）
  await page.evaluate(() => window.__cubevision.startFromSolved());
  await page.waitForFunction(() => !!window.__cubevision.store.get().cube, null, { timeout: 30000 });
  return { page, logs };
}

async function analyze(page, file, fps) {
  await page.locator('.video-analysis input[type="file"]').setInputFiles(file);
  await page.waitForSelector('.video-analysis input[type="number"]', { timeout: 60000 });
  if (fps) await page.locator('.video-analysis input[type="number"]').fill(String(fps));
  const t0 = Date.now();
  await page.locator(".video-analysis button", { hasText: "解析する" }).click();
  await page.waitForSelector('.video-analysis[data-phase="done"], .video-analysis[data-phase="error"]', { timeout: 900000 });
  const text = await page.locator(".video-analysis").innerText();
  const moves = (await page.locator(".video-analysis .video-moves .mv").allInnerTexts()).join(" ");
  return { text, moves: norm(moves), sec: (Date.now() - t0) / 1000 };
}

try {
  if (FREE) {
    const { page, logs } = await open();
    await page.evaluate(() => window.__cubevision.store.set({ panel: "free" }));
    await page.locator("button", { hasText: "動画を解析" }).click();
    const r = await analyze(page, FREE);
    await page.screenshot({ path: `${OUT}/free.png`, fullPage: true });
    const want = `${TPERM} ${TPERM}`;
    const ok = r.moves === want;
    if (!ok) failures++;
    console.log(`free: ${ok ? "OK" : "NG"} ${r.sec.toFixed(0)}s\n  moves: ${r.moves}\n  want : ${want}`);
    if (!ok) console.log(r.text, logs.slice(-20).join("\n"));
    await page.close();
  }
  if (TIMER) {
    const { page, logs } = await open();
    await page.evaluate(() => window.__cubevision.store.set({ panel: "timer" }));
    // 動画の前に回したスクランブルを表示しておく
    await page.evaluate((s) => {
      const F = ["U", "R", "F", "D", "L", "B"];
      const moves = s.split(" ").map((t) => F.indexOf(t[0]) * 3 + (t[1] === "2" ? 1 : t[1] === "'" ? 2 : 0));
      window.__cubevisionTimer.set({ scramble: moves });
    }, TIMER_SCRAMBLE);
    await page.locator("button", { hasText: "スロー動画から記録" }).click();
    const r = await analyze(page, TIMER, 240);
    await page.screenshot({ path: `${OUT}/timer.png`, fullPage: true });
    const solve = await page.evaluate(() => window.__cubevisionTimer.get().solves[0]);
    const err = solve ? solve.timeMs - TIMER_TRUTH_MS : NaN;
    const ok = !!solve?.video && r.moves === TIMER_SOLUTION && Math.abs(err) < 20;
    if (!ok) failures++;
    console.log(`timer: ${ok ? "OK" : "NG"} ${r.sec.toFixed(0)}s time ${solve?.timeMs?.toFixed(0)}ms (truth ${TIMER_TRUTH_MS.toFixed(0)}ms, err ${err.toFixed(0)}) moves ${r.moves} scramble ${solve?.scramble}`);
    if (!ok) console.log(r.text, logs.slice(-20).join("\n"));
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}
process.exit(failures ? 1 : 0);

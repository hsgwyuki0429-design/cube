// ArUco 検証ページ（aruco.html）の端から端までのテスト: ビルド済みのページをヘッドレス Chromium で開き、
// 動画ファイルを読み込ませて解析し、結果の表と画面を e2e-output/aruco/ に書き出す。
//
//   npm run build && ARUCO_VIDEO=path/to/video.mp4 node scripts/aruco-e2e.mjs
//   （合成動画は tests/debug/arucoVideo.debug.test.ts で作れる）
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename } from "node:path";
import { chromium } from "playwright-core";

const VIDEO = process.env.ARUCO_VIDEO;
const OUT = process.env.E2E_OUT ?? "e2e-output/aruco";
const SHEET = process.env.ARUCO_SHEET ?? "test";
const CONFIGS = process.env.ARUCO_CONFIGS; // 例: "0,1"（既定は全部）
const CHROME = process.env.CHROME_PATH ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
if (!VIDEO || !existsSync(VIDEO)) {
  console.error("ARUCO_VIDEO に動画ファイルを指定してください");
  process.exit(1);
}
if (!existsSync("dist/aruco.html")) {
  console.error("dist/ がありません。先に npm run build を実行してください。");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const PORT = await new Promise((resolve) => {
  const srv = createServer();
  srv.listen(0, () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});
const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "pipe" });
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => String(d).includes(String(PORT)) && resolve());
  server.on("exit", (c) => reject(new Error(`preview exited ${c}`)));
  setTimeout(resolve, 8000);
});

const browser = await chromium.launch({ executablePath: CHROME });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: Number(process.env.E2E_WIDTH ?? 1100), height: 1400 } });
  page.on("console", (m) => m.type() === "error" && console.log("[page]", m.text()));
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(`http://localhost:${PORT}/aruco.html`);
  await page.waitForFunction(() => !document.body.textContent.includes("OpenCV.js を読み込み中"), null, { timeout: 120000 });
  await page.setInputFiles('input[type="file"]', VIDEO);
  await page.selectOption("select >> nth=0", SHEET);
  if (CONFIGS) {
    const want = new Set(CONFIGS.split(",").map(Number));
    const boxes = page.locator('fieldset input[type="checkbox"]');
    for (let i = 0; i < (await boxes.count()); i++) if (!want.has(i)) await boxes.nth(i).uncheck();
  }
  const t0 = Date.now();
  await page.click("text=解析する");
  await page.waitForFunction(() => document.body.textContent.includes("2. 結果") || document.querySelector(".status-banner.bad"), null, { timeout: 1800000 });
  const err = await page.locator(".status-banner.bad").allTextContents();
  if (err.length) throw new Error(err.join("\n"));
  console.log(`解析 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  const tables = await page.$$eval("table.list", (ts) =>
    ts.map((t) => [...t.querySelectorAll("tr")].map((r) => [...r.querySelectorAll("th,td")].map((c) => c.textContent.trim()).join(" | ")).join("\n")),
  );
  const text = tables.join("\n\n");
  console.log(text.split("\n\n").slice(0, -1).join("\n\n"));
  writeFileSync(`${OUT}/${basename(VIDEO)}.tables.txt`, text);
  await page.screenshot({ path: `${OUT}/${basename(VIDEO)}.page.png`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 0) throw new Error(`ページが横に ${overflow}px はみ出しています`);
  // 振っている途中のフレームを表示して重ね描きを確かめる
  const viewer = page.locator(".viewer");
  await viewer.scrollIntoViewIfNeeded();
  for (const [i, label] of [
    [60, "still"],
    [330, "moving"],
  ]) {
    await page.evaluate((k) => {
      const v = document.querySelector(".viewer video");
      v.pause();
      v.currentTime = k / 240 + 0.001;
    }, i);
    await page.waitForTimeout(800);
    await viewer.screenshot({ path: `${OUT}/${basename(VIDEO)}.${label}.png` });
  }
  // どの方式でも 1 つも読めなかったフレーム
  const empty = await page.evaluate(() => {
    const { frames } = window.__aruco;
    return frames.map((f, i) => [i, f.t, f.results.every((r) => r.markers.length === 0)]).filter((x) => x[2]).map((x) => `${x[0]}@${x[1].toFixed(1)}ms`);
  });
  console.log(`全方式で検出なしのフレーム: ${empty.length ? empty.join(" ") : "なし"}`);
  const hint = await page.locator(".aruco .hint", { hasText: "フレーム" }).first().textContent();
  console.log(hint);
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);

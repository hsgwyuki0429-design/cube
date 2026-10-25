// 本体の ArUco の画面の端から端までのテスト: ビルド済みのアプリを aruco.html（本体の #aruco へ移動する）から開き、
// 動画ファイルを読み込ませて解析し、結果の表と画面を e2e-output/aruco/ に書き出す。
//
//   npm run build && ARUCO_VIDEO=path/to/video.mp4 node scripts/aruco-e2e.mjs                  # テストモード（シート）
//   ARUCO_SCHEME=aruco54 …                                                                    # 54 種類（4×4）のステッカー（既定は 12 種類）
//   ARUCO_MODE=cube ARUCO_TRUTH="R U R' U'" [ARUCO_END_SOLVED=1] ARUCO_VIDEO=… node scripts/aruco-e2e.mjs  # キューブモード
//   （合成動画は tests/debug/arucoVideo.debug.test.ts・arucoCubeVideo.debug.test.ts で作れる）
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename } from "node:path";
import { chromium } from "playwright-core";

const VIDEO = process.env.ARUCO_VIDEO;
const OUT = process.env.E2E_OUT ?? "e2e-output/aruco";
const SCHEME = process.env.ARUCO_SCHEME ?? "aruco12"; // aruco12 | aruco54（src/aruco/codes.ts）
const SHEET = process.env.ARUCO_SHEET ?? (SCHEME === "aruco12" ? "t12" : "test");
const MODE = process.env.ARUCO_MODE ?? "sheet"; // sheet | cube
const TRUTH = process.env.ARUCO_TRUTH ?? "";
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

// キューブモード: 解析して推定した手順を正解と比べる。一致すれば true
async function runCube(page) {
  if (process.env.ARUCO_END_SOLVED) await page.check("text=最後は揃った状態");
  const t0 = Date.now();
  await page.click("text=解析する");
  await page.waitForFunction(() => document.body.textContent.includes("2. 推定した手順") || document.querySelector(".status-banner.bad"), null, { timeout: 1800000 });
  const err = await page.locator(".status-banner.bad").allTextContents();
  if (err.length) throw new Error(err.join("\n"));
  console.log(`解析 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  if (TRUTH) await page.fill('input[type="text"]', TRUTH);
  const res = await page.evaluate(() => {
    const { cube } = window.__aruco;
    const names = ["U", "R", "F", "D", "L", "B"].flatMap((f) => [f, f + "2", f + "'"]);
    return { moves: cube.result.moves.map((m) => names[m.move] + (m.inferred ? "*" : "")).join(" "), result: { ...cube.result, moves: undefined, raw: undefined } };
  });
  console.log("推定:", res.moves);
  if (process.env.ARUCO_DUMP) {
    // フレームごとの面の読めたマス（調査用）
    const dump = await page.evaluate(() => {
      const { cube, frames } = window.__aruco;
      return cube.faces.map((fs, i) => `${frames[i].t.toFixed(1)} ${frames[i].results[0].markers.length} ${fs.map((f) => `${f.slot}:${f.ids.filter((x) => x >= 0).length}`).join(",")}`).join("\n");
    });
    writeFileSync(`${OUT}/${basename(VIDEO)}.faces.txt`, dump);
    const mv = await page.evaluate(() => window.__aruco.cube.result.moves.map((m) => `${m.move} ${m.t0?.toFixed(1)} ${m.t.toFixed(1)} ${m.inferred ? "inf" : ""}`).join("\n"));
    writeFileSync(`${OUT}/${basename(VIDEO)}.moves.txt`, mv);
  }
  console.log(JSON.stringify(res.result));
  const verdict = await page.locator(".status-banner.ok, .status-banner.bad").allTextContents();
  console.log(verdict.join("\n"));
  await page.screenshot({ path: `${OUT}/${basename(VIDEO)}.page.png`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 0) throw new Error(`ページが横に ${overflow}px はみ出しています`);
  const viewer = page.locator(".viewer");
  await viewer.scrollIntoViewIfNeeded();
  for (const [sec, label] of [
    [0.1, "still"],
    [0.35, "turning"],
  ]) {
    await page.evaluate((s) => {
      const v = document.querySelector(".viewer video");
      v.pause();
      v.currentTime = s;
    }, sec);
    await page.waitForTimeout(800);
    await page.locator(".card", { hasText: "3. 動画で確かめる" }).screenshot({ path: `${OUT}/${basename(VIDEO)}.${label}.png` });
  }
  // 3D キューブ（動画に合わせて動くもの・手順の再生）が出ていること。最後の手の後で、動画の 3D が全部の手を回し終えた状態
  const n3d = await page.evaluate(() => [".cube-3d twisty-player", ".cube-replay twisty-player"].map((q) => document.querySelectorAll(q).length));
  if (n3d.join() !== "1,1") throw new Error(`3D キューブがない: ${n3d}`);
  await page.evaluate(() => {
    const v = document.querySelector(".viewer video");
    v.pause();
    v.currentTime = v.duration - 0.01;
  });
  await page.waitForTimeout(2500);
  await page.locator(".card", { hasText: "3. 動画で確かめる" }).screenshot({ path: `${OUT}/${basename(VIDEO)}.end.png` });
  await page.locator(".card", { hasText: "2. 推定した手順" }).screenshot({ path: `${OUT}/${basename(VIDEO)}.replay.png` });
  if (!TRUTH) return true;
  const want = TRUTH.trim().split(/\s+/).join(" ");
  return res.moves.replace(/\*/g, "") === want;
}

const browser = await chromium.launch({ executablePath: CHROME });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: Number(process.env.E2E_WIDTH ?? 1100), height: 1400 } });
  page.on("console", (m) => m.type() === "error" && console.log("[page]", m.text()));
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(`http://localhost:${PORT}/aruco.html`);
  await page.waitForFunction(() => !document.body.textContent.includes("OpenCV.js を読み込み中"), null, { timeout: 120000 });
  await page.selectOption('label:has-text("ステッカーの種類") select', SCHEME);
  await page.setInputFiles('input[type="file"]', VIDEO);
  if (MODE === "cube") {
    failed = !(await runCube(page));
    throw "skip";
  }
  await page.click("text=シート（検出率）");
  await page.selectOption('label:has-text("写したシート") select', SHEET);
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
  if (e !== "skip") {
    failed = true;
    console.error(e);
  }
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);

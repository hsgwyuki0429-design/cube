// 撮り方の案内（src/app/captureAdvice.ts）の端から端までのテスト: 偽のカメラ（Chromium の --use-file-for-fake-video-capture）で、
// 揃ったキューブを「遠い・暗い・真上から・端に寄っている・ふつう」の場面で写した動画を流し、出た案内の文が場面に合うかを確かめる。
//   動画は tests/debug/fakeCamVideo.debug.test.ts（FAKE_ONLY=hold）で作る。場面ごとに FAKE_DIST=2.4（遠い）・FAKE_BRIGHT=0.3（暗い）・
//   FAKE_EYE="0.25,6.5,0.6"（真上から）・FAKE_SHIFT="-2.6,0"（端に寄る）
//   npm run build && ADVICE_SCENES='far=far.y4m:closer,dark=dark.y4m:light,top=top.y4m:angle,edge=edge.y4m:center,ok=ok.y4m:-' node scripts/advice-e2e.mjs
//   （名前=動画:出るはずの案内（- = 出ない））
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "playwright-core";

const CHROME = process.env.CHROME_PATH ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const scenes = (process.env.ADVICE_SCENES ?? "").split(",").filter(Boolean).map((s) => {
  const [name, rest] = s.split("=");
  const [file, want] = rest.split(":");
  return { name, file, want: want === "-" ? null : want };
});
if (!scenes.length) {
  console.error("ADVICE_SCENES がありません");
  process.exit(1);
}
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
let failures = 0;
try {
  for (const sc of scenes) {
    const browser = await chromium.launch({
      executablePath: CHROME,
      args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${sc.file}`],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.context().grantPermissions(["camera"]);
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForFunction(() => window.__cubevision?.vision?.isReady && window.__cubevisionAdvice, null, { timeout: 60000 });
    await page.waitForFunction(() => window.__cubevision.store.get().camera !== "off", null, { timeout: 3000 }).catch(() => page.evaluate(() => window.__cubevision.startCamera()));
    await page.waitForFunction(() => window.__cubevision.store.get().camera === "on", null, { timeout: 30000 });
    // 案内が出るまで（出ないはずの場面は 7 秒見る）
    const seen = new Set();
    const t0 = Date.now();
    while (Date.now() - t0 < 7000) {
      const k = await page.evaluate(() => window.__cubevisionAdvice.get().key);
      if (k) seen.add(k);
      if (sc.want && seen.has(sc.want)) break;
      await page.waitForTimeout(200);
    }
    const text = await page.locator(".capture-advice").first().textContent({ timeout: 500 }).catch(() => null);
    const ok = sc.want ? seen.has(sc.want) && seen.size === 1 : seen.size === 0;
    if (!ok) failures++;
    console.log(`${sc.name}: ${ok ? "OK" : "NG"} 出た案内 ${[...seen].join(",") || "なし"}（期待 ${sc.want ?? "なし"}）${text ? `「${text}」` : ""}・${await page.evaluate(() => JSON.stringify(window.__cubevision.store.get().stats))}`);
    await page.screenshot({ path: `e2e-output/advice-${sc.name}.png` }).catch(() => undefined);
    await browser.close();
  }
} finally {
  server.kill();
}
process.exit(failures ? 1 : 0);

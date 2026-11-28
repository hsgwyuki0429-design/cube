// 端から端までのテスト: ビルド済みアプリをヘッドレス Chromium で開き、デモモード（合成カメラ）で
// 「6面スキャン → 指定手数を回す」を実行して、追跡した手順を正解と比較する。
//
//   npm run build && npm run e2e            # 既定: 2面が見える位置・2TPS・30手
//   E2E_VIEW=corner E2E_TPS=3 npm run e2e
//   E2E_NOHELPER=1（認識の補助の Worker を使わない）
//   E2E_QUERY='&refinepool=0'（URL に足す。&refinepool=0 はタイマーの精密解析で検出を別の Worker に分けない）
//   E2E_MODE=timer E2E_EXPORT=フォルダ E2E_EXPORT_CHECK=1（「録画を書き出す」を押して保存し、手元の realVideo で解析し直してアプリの結果と比べる。
//   E2E_EXPORT_STATS=rows.jsonl で読める量の物差しも足す）
//   E2E_MODE=timer E2E_FAKECAM=動画.y4m E2E_SCRAMBLE='R2 B2 …'（デモの合成カメラの代わりに、偽のカメラ（Chromium の
//   --use-file-for-fake-video-capture）で 60fps の合成動画を流す: tests/debug/fakeCamVideo.debug.test.ts。E2E_CORES=4 で Chromium を CPU 4 つに絞る。
//   E2E_PERF=rows.jsonl で 1 秒ごとの処理の様子を足す。ソルブ中の重さの配り方は E2E_QUERY='&solveload=pause' など）
//   E2E_MODE=timer E2E_NEXT=1（止めた後、精密解析の間にライブが休み始めたら「次のソルブ」を押し、合成キューブで案内どおりに崩す。
//   休みが「次のソルブ」で解け、案内が最後まで進んでインスペクションになれば OK: src/app/liveRest.ts。デモの合成カメラのときだけ）
//   E2E_MODE=timer E2E_LIVELOG=フォルダ（「ライブの記録を書き出す」を押して保存する。手元の tests/debug/liveLog.debug.test.ts で通し直す）
//   E2E_MODE=timer E2E_BUNDLE=フォルダ（設定の「開発用の書き出し」をオンにして始め、止めた後の画面の「書き出す」で録画・ライブの記録・要約を
//   1 つにしたファイルを保存する: src/ui/bundleExport.ts。中身と組の印を確かめ、止めた後の画面の画像も残す。E2E_EXPORT_CHECK=1 なら、そのファイル
//   だけで realVideo（アプリの結果と同じか）と liveLog（実機と同じか・3D の一致）を通す）
//   E2E_MODE=timer E2E_VFRAME_FAIL=5（カメラの映像からの new VideoFrame を最初の 5 回 InvalidStateError で失敗させる: 実機の iPhone で、映像が
//   届く前の 1 回の失敗でずっと bitmap に戻っていた件。src/vision/frameGate.ts）。タイマーでは、VideoFrame を頼んだのにフレームの渡し方が
//   vframe でなければ NG（書き出しを保存したときは、書き出しの framePath も見る）
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

// ライブの 3D が回して見せた手（LiveCube3D の window.__cubevisionTurns）を、合成キューブの本当の手（同じ面で、回し始め 300ms 前〜回し終わり
// 1 秒後）に結びつける。結びつかない手 = 回していないのに回して見せた手（持ち替え・傾けを手で説明したもの）
async function turnStats(page) {
  const { turns, truth, solveFrom } = await page.evaluate(() => ({ turns: window.__cubevisionTurns ?? [], truth: (window.__cubevision.synthetic?.truth ?? []).map((x) => ({ ...x })), solveFrom: window.__cubevision.synthetic?.solveFrom ?? -1 }));
  const used = new Set();
  const fake = [];
  const shown = turns.filter((x) => !x.instant);
  for (const a of shown) {
    const j = truth.findIndex((m, k) => !used.has(k) && Math.floor(m.move / 3) === Math.floor(a.move / 3) && a.t >= m.start - 300 && a.t <= m.t + 1000);
    if (j >= 0) used.add(j);
    else fake.push(a);
  }
  const t0 = truth[0]?.start ?? 0;
  // タイマー: インスペクション（崩し終わりの 1 秒後〜解き始め。手を回していない: &look なら持ち替えて見回すだけ）に回して見せた手
  const inspect = solveFrom > 0 ? shown.filter((x) => x.t > truth[solveFrom - 1].t + 1000 && x.t < truth[solveFrom].start).length : 0;
  return `3D: 回した ${shown.length}・結びつかない ${fake.length}${solveFrom > 0 ? `（うちインスペクション中 ${inspect}）` : ""}${fake.length ? `（${fake.map((x) => `${name(x.move)}@${((x.t - t0) / 1000).toFixed(1)}s`).join(" ")}）` : ""}・塗り替え ${turns.length - shown.length}・本当の手を回した ${used.size}/${truth.length}`;
}

const FAKECAM = process.env.E2E_FAKECAM;
// E2E_CORES=4: Chromium（とその子のプロセス）を CPU 4 つに絞る（taskset）。実機の iPhone（4 コア）に近づける
const CORES = process.env.E2E_CORES;
let launchPath = CHROME;
if (CORES) {
  const { writeFileSync, chmodSync } = await import("node:fs");
  const wrap = `${OUT}/chromium-${CORES}cores.sh`;
  writeFileSync(wrap, `#!/bin/sh\nexec taskset -c 0-${Number(CORES) - 1} ${CHROME ?? "chromium"} "$@"\n`);
  chmodSync(wrap, 0o755);
  launchPath = wrap;
}
const browser = await chromium.launch({
  executablePath: launchPath,
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--autoplay-policy=no-user-gesture-required",
    "--ignore-gpu-blocklist",
    ...(FAKECAM ? ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${FAKECAM}`] : []),
  ],
});
let failures = 0;
const results = [];
try {
  for (const seed of SEEDS) {
    // E2E_VIEWPORT=393x852: 画面の大きさ（偽のカメラで重さを比べるときは iPhone の大きさにする。ヘッドレスの Chromium は描画も CPU なので、大きい画面の描画が fps を下げる）
    const [vw, vh] = (process.env.E2E_VIEWPORT ?? "1400x900").split("x").map(Number);
    const page = await browser.newPage({ viewport: { width: vw, height: vh } });
    const logs = [];
    page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
    const t0 = Date.now();
    // E2E_NOHELPER=1: 認識の補助の Worker を使わない（コアが少ない端末のように）
    if (process.env.E2E_NOHELPER) await page.addInitScript(() => Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 2 }));
    // E2E_VFRAME_FAIL=N: カメラの映像（<video>）からの new VideoFrame を最初の N 回、映像のフレームがまだないときと同じ InvalidStateError で失敗させる
    if (process.env.E2E_VFRAME_FAIL)
      await page.addInitScript((n) => {
        const Orig = window.VideoFrame;
        if (!Orig) return;
        let left = n;
        window.__vframeFailed = 0;
        window.VideoFrame = new Proxy(Orig, {
          construct(target, args) {
            if (left > 0 && args[0] instanceof HTMLVideoElement) {
              left--;
              window.__vframeFailed++;
              throw new DOMException("Failed to construct 'VideoFrame': Video element has no video frame", "InvalidStateError");
            }
            return Reflect.construct(target, args);
          },
        });
      }, Number(process.env.E2E_VFRAME_FAIL));
    // E2E_READINGS=1: 設定の「読み取りを表示」をオンにして始める（src/ui/CameraView.tsx）。E2E_BUNDLE: 「開発用の書き出し」をオンに
    if (process.env.E2E_READINGS || process.env.E2E_BUNDLE)
      await page.addInitScript((on) => {
        const k = "cubevision.settings.v1";
        let cur = {};
        try {
          cur = JSON.parse(localStorage.getItem(k) ?? "{}");
        } catch {}
        localStorage.setItem(k, JSON.stringify({ ...cur, ...on }));
      }, { ...(process.env.E2E_READINGS ? { showReadings: true } : {}), ...(process.env.E2E_BUNDLE ? { devExport: true } : {}) });
    if (FAKECAM) {
      // 偽のカメラ: カメラを開始し（動画は開いたときから流れる。最初の 6 秒は揃った状態）、揃った状態から始めて、動画と同じスクランブルを出す
      await page.context().grantPermissions(["camera"]);
      await page.goto(`http://localhost:${PORT}/?scramble=${encodeURIComponent(process.env.E2E_SCRAMBLE ?? "")}${process.env.E2E_QUERY ?? ""}`);
      await page.waitForFunction(() => window.__cubevision?.vision?.isReady, null, { timeout: 60000 });
      // カメラを許可してあるので、アプリが自分で開始する（来なければ開始する）
      await page.waitForFunction(() => window.__cubevision.store.get().camera !== "off", null, { timeout: 3000 }).catch(() => page.evaluate(() => window.__cubevision.startCamera()));
      await page.waitForFunction(() => window.__cubevision.store.get().camera === "on", null, { timeout: 30000 });
      await page.evaluate(() => window.__cubevision.startFromSolved());
      await page.waitForFunction(() => !!window.__cubevision.store.get().cube, null, { timeout: 30000 });
      await page.evaluate(() => window.__cubevisionNewScramble());
    } else await page.goto(`http://localhost:${PORT}/?demo=e2e&seed=${seed}&moves=${MOVES}&tps=${TPS}&view=${VIEW}${MODE === "timer" ? "&timer=1" : ""}${process.env.E2E_PAD ? "&pad=1" : ""}${process.env.E2E_QUERY ?? ""}`);
    if (MODE === "timer") {
      // 撮り方の案内（src/app/captureGuide.ts）が出た場面を 100ms ごとに残す（インスペクション・ソルブ中に出たら NG）
      await page.evaluate(() => {
        window.__adviceLog = [];
        setInterval(() => {
          const k = window.__cubevisionAdvice?.get().key;
          if (k) window.__adviceLog.push([window.__cubevisionTimer.get().phase, k]);
        }, 100);
      });
      try {
        // E2E_SHOTS=フォルダ: スクランブル中（3 手目から）・インスペクション（1 秒後）・ソルブ中（2 秒後）の画面を撮る
        if (process.env.E2E_SHOTS) {
          mkdirSync(process.env.E2E_SHOTS, { recursive: true });
          const shot = { scrambling: false, inspection: false, solving: false };
          const since = {};
          const t0s = Date.now();
          while (Date.now() - t0s < 240000) {
            const ph = await page.evaluate(() => ({ phase: window.__cubevisionTimer.get().phase, done: window.__cubevisionTimer.get().guideDone }));
            if (ph.phase === "done") break;
            since[ph.phase] ??= Date.now();
            const wait = { scrambling: 0, inspection: 1000, solving: 2000 }[ph.phase];
            if (wait !== undefined && !shot[ph.phase] && Date.now() - since[ph.phase] >= wait && (ph.phase !== "scrambling" || ph.done >= 3)) {
              shot[ph.phase] = true;
              await page.screenshot({ path: `${process.env.E2E_SHOTS}/seed${seed}-${ph.phase}.png` });
              console.log(`  画面: ${process.env.E2E_SHOTS}/seed${seed}-${ph.phase}.png`);
            }
            await page.waitForTimeout(100);
          }
        }
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
      // E2E_NEXT=1: 休み中に「次のソルブ」を押して崩す（解析の結果は待たない）
      if (process.env.E2E_NEXT && !FAKECAM) {
        const rested = await page.waitForFunction(() => window.__cubevision.liveRest.resting, null, { timeout: 15000, polling: 50 }).then(() => true).catch(() => false);
        const pendingAtNext = await page.evaluate(() => window.__cubevisionTimer.get().result?.analysis === "pending");
        await page.evaluate(() => window.__cubevisionNewScramble());
        const t1 = Date.now();
        let turns = 0;
        while (Date.now() - t1 < 90000) {
          const st = await page.evaluate(() => window.__cubevisionTimer.get().phase);
          if (st === "inspection") break;
          const m = await page.evaluate(() => (window.__cubevisionTimer.get().recomputing ? null : window.__cubevisionNextGuideMove()));
          if (m === null || m === undefined) {
            await page.waitForTimeout(200);
            continue;
          }
          const before = await page.evaluate(() => { const t = window.__cubevisionTimer.get(); return `${t.guideDone}:${t.guideHalf}:${t.guideFix?.join(",")}`; });
          await page.evaluate((mv) => window.__cubevision.synthetic.move(mv, 250), m);
          turns++;
          await page.waitForFunction((b) => { const t = window.__cubevisionTimer.get(); return t.phase !== "scrambling" || `${t.guideDone}:${t.guideHalf}:${t.guideFix?.join(",")}` !== b; }, before, { timeout: 3000, polling: 50 }).catch(() => undefined);
          await page.waitForTimeout(250);
        }
        const nx = await page.evaluate(() => ({ phase: window.__cubevisionTimer.get().phase, guide: window.__cubevisionTimer.get().guide.length, done: window.__cubevisionTimer.get().guideDone, rests: window.__cubevision.perf.rests.map((r) => ({ ...r })) }));
        const last = nx.rests[nx.rests.length - 1];
        const okNext = rested && last?.why === "next" && nx.phase === "inspection";
        console.log(`  次のソルブ（休み中）: ${okNext ? "OK" : "NG"} 休み ${rested ? "あり" : "なし"}・押したとき解析 ${pendingAtNext ? "中" : "済み"}・休みの終わり ${last ? `${last.why}（${((last.t1 - last.t0) / 1000).toFixed(1)} 秒）` : "-"}・案内 ${nx.done}/${nx.guide}・${turns} 手回して ${nx.phase}`);
        if (!okNext) failures++;
        await page.waitForFunction((id) => window.__cubevisionTimer.get().solves.find((x) => x.id === id)?.analysis !== "pending", live?.id, { timeout: 240000, polling: 500 }).catch(() => undefined);
        console.log(`  前のソルブの解析: ${await page.evaluate((id) => window.__cubevisionTimer.get().solves.find((x) => x.id === id)?.analysis, live?.id)}（live ${(live?.timeMs / 1000).toFixed(3)}s）`);
        await page.close();
        continue;
      }
      // E2E_BUNDLE: 解析中の止めた後の画面（「書き出す」は押せず「解析中」）
      if (process.env.E2E_BUNDLE) {
        await page.waitForSelector(".dev-export button", { timeout: 10000 }).catch(() => undefined);
        const label = await page.locator(".dev-export button").textContent().catch(() => null);
        const disabled = await page.evaluate(() => document.querySelector(".dev-export button")?.disabled ?? null);
        await page.screenshot({ path: `${OUT}/seed${seed}-done-analyzing.png` });
        const pendingNow = await page.evaluate(() => window.__cubevisionTimer.get().result?.analysis === "pending");
        const ok = !pendingNow || (disabled === true && label === "解析中");
        console.log(`  解析中の書き出しのボタン: ${ok ? "OK" : "NG"}（${label ?? "なし"}・${disabled ? "押せない" : "押せる"}・解析 ${pendingNow ? "中" : "済み"}）`);
        if (!ok) failures++;
      }
      // 録画の精密解析が終わるまで待つ（止めてから確定するまでの時間も出す）
      const waitFrom = Date.now();
      await page.waitForFunction(() => window.__cubevisionTimer.get().result?.analysis !== "pending", null, { timeout: 240000, polling: 500 }).catch(() => undefined);
      await page.screenshot({ path: `${OUT}/seed${seed}-timer-analyzed.png` });
      const r = await page.evaluate(() => {
        const t = window.__cubevisionTimer.get();
        const syn = window.__cubevision.synthetic;
        return { startT: t.startT, inspectionStart: t.inspectionStart, truthStart: syn && syn.solveFrom >= 0 ? syn.truth[syn.solveFrom]?.start : NaN, truthEnd: syn?.truth[syn.truth.length - 1]?.t, helper: window.__cubevision.vision?.helperFrames, processed: window.__cubevision.vision?.processed, rec: window.__cubevisionAnalysis?.recording, result: t.result, solves: t.solves.length, solved: window.__cubevision.store.get().track?.solved, truth: syn ? syn.truth.slice(syn.solveFrom).map((x) => ({ ...x })) : [] };
      });
      // 正解: 解き始め（インスペクション後の最初の手）から最後の手まで
      const n = r.result?.moves.length ?? 0;
      const sol = r.truth;
      const truthMs = sol.length ? sol[sol.length - 1].t - sol[0].start : NaN;
      const ok = r.result && r.result.tracked && r.solved && r.result.timeMs > 0 && n > 5;
      const analysisOk = r.result?.analysis === "done" || process.env.E2E_ALLOW_NO_ANALYSIS;
      console.log(
        `seed ${seed} timer: ${ok ? "OK" : "NG"} live ${(live?.timeMs / 1000).toFixed(3)}s → ${r.result?.analysis}${r.result?.refineMethod ? `(${r.result.refineMethod})` : ""} ${(r.result?.timeMs / 1000).toFixed(3)}s (truth ≈ ${(truthMs / 1000).toFixed(3)}s, ${sol.length} moves) moves ${n}${r.result?.moves.some((m) => m.inferred) ? ` 推定 ${r.result.moves.map((m, i) => (m.inferred ? i : -1)).filter((i) => i >= 0).join(",")}` : ""} tps ${r.result?.tps.toFixed(2)} ${r.result?.pad ? `pad ${JSON.stringify(r.result.pad)} ` : ""}splits ${JSON.stringify(r.result?.splits?.map((x) => [x.name, x.moves]))} 認識 ${r.processed} 枚（うち補助 ${r.helper}） rec ${r.rec ? `${r.rec.bitrate / 1e6}Mbps ${r.rec.frames} 枚・間引き ${r.rec.dropped}` : "-"} analysis-wait ${((Date.now() - waitFrom) / 1000).toFixed(1)}s ${logs.filter((l) => l.includes("[analysis]")).map((l) => l.replace(/^.*\[analysis\] /, "")).join(" / ")}`,
      );
      // 1 秒ごとの処理の様子（src/app/perfLog.ts）を場面ごとに（ライブ 2.5: ソルブ中の fps の低下）
      const perf = await page.evaluate(() => {
        const c = window.__cubevision;
        const t = window.__cubevisionTimer.get();
        const end = t.startT + (t.result?.provisionalMs ?? t.result?.timeMs ?? 0);
        const now = performance.now();
        return { inspect: c.perfSummary(t.inspectionStart, t.startT), solve: c.perfSummary(t.startT, end), after: c.perfSummary(end, now), rows: c.perf.rows.filter((r) => r.t >= t.inspectionStart - 2000), rests: c.perf.rests.map((r) => ({ ...r })), framePath: c.framePath() };
      });
      console.log(`  perf インスペクション: ${perf.inspect}\n  perf ソルブ: ${perf.solve}\n  perf 止めた後〜解析: ${perf.after}\n  フレームの渡し方 ${JSON.stringify(perf.framePath)}・ライブの休み ${perf.rests.map((r) => `${r.t1 !== undefined ? ((r.t1 - r.t0) / 1000).toFixed(1) : "?"} 秒（${r.why ?? "続いている"}）`).join("・") || "なし"}`);
      // VideoFrame を頼んだのに今までのやり方に戻っていたら NG（一時的な失敗では戻さない: src/vision/frameGate.ts）
      const vframeFailed = await page.evaluate(() => window.__vframeFailed ?? 0);
      if (vframeFailed) console.log(`  VideoFrame をわざと失敗させた回数 ${vframeFailed}`);
      const pathNg = (fp) => fp?.requested && (fp.live !== "vframe" || fp.recorder !== "vframe");
      if (pathNg(perf.framePath)) {
        console.log(`  フレームの渡し方: NG（VideoFrame を頼んだのに戻っている）`);
        failures++;
      } else if (perf.framePath?.requested) console.log(`  フレームの渡し方: OK（live ${perf.framePath.live}・一時的に送らなかった ${perf.framePath.liveWaits} 回）`);
      if (process.env.E2E_PERF) {
        const { appendFileSync } = await import("node:fs");
        appendFileSync(process.env.E2E_PERF, `${JSON.stringify({ seed, query: process.env.E2E_QUERY ?? "", waitMs: Date.now() - waitFrom, analysis: r.result?.analysis, method: r.result?.refineMethod, inferred: r.result?.moves.filter((m) => m.inferred).length, moves: n, processed: r.processed, rec: r.rec, rows: perf.rows, rests: perf.rests, framePath: perf.framePath, startT: r.startT, inspectionStart: r.inspectionStart, live: live?.timeMs })}\n`);
      }
      const advice = await page.evaluate(() => window.__adviceLog ?? []);
      const byPhase = {};
      for (const [ph, k] of advice) byPhase[`${ph}:${k}`] = (byPhase[`${ph}:${k}`] ?? 0) + 1;
      const quietBad = advice.filter(([ph]) => ph === "inspection" || ph === "solving").length;
      console.log(`  撮り方の案内: ${Object.entries(byPhase).map(([k, n]) => `${k} ${n}`).join("・") || "なし"}${quietBad ? "（NG: インスペクション・ソルブ中に出た）" : ""}`);
      if (quietBad) failures++;
      // 開始・停止のずれ（リアルタイムの速報値。+ = 遅い）と、インスペクションの長さ
      console.log(`  why: ${JSON.stringify(r.result?.edges ?? null)}`);
      console.log(`  ${await turnStats(page)}`);
      console.log(`  edges: start ${((r.startT - r.truthStart) / 1000).toFixed(3)}s stop ${((r.startT + (live?.timeMs ?? 0) - r.truthEnd) / 1000).toFixed(3)}s inspection ${((r.truthStart - r.inspectionStart) / 1000).toFixed(2)}s analysis ${r.result?.analysis}`);
      for (const l of logs.filter((l) => l.includes("[start]") || l.includes("[stop]"))) console.log(`  ${l}`);
      // E2E_EXPORT=フォルダ: 設定画面の「録画を書き出す」を押して、書き出した録画を保存する。E2E_EXPORT_CHECK=1 なら手元の
      // realVideo（tests/debug/realVideo.debug.test.ts）で精密解析し直し、アプリの結果と同じかを確かめる（違えば NG）
      // E2E_BUNDLE=フォルダ: 止めた後の画面の開発用の「書き出す」（録画・ライブの記録・要約を 1 つに）
      if (process.env.E2E_BUNDLE) {
        const dir = process.env.E2E_BUNDLE;
        mkdirSync(dir, { recursive: true });
        const btn = page.locator(".dev-export button");
        const before = await btn.textContent().catch(() => null);
        await page.waitForFunction(() => document.querySelector(".dev-export button")?.disabled === false, null, { timeout: 60000, polling: 200 }).catch(() => undefined);
        await page.screenshot({ path: `${OUT}/seed${seed}-done-export.png` });
        const summaryText = await page.locator(".dev-summary").textContent().catch(() => null);
        console.log(`  書き出しのボタン: 解析の後 ${before ?? "-"} → ${await btn.textContent().catch(() => "-")}\n  要約（画面）:\n    ${(summaryText ?? "（なし）").split("\n").join("\n    ")}`);
        const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), btn.click()]);
        const file = `${dir}/seed${seed}-${dl.suggestedFilename()}`;
        await dl.saveAs(file);
        const { readFileSync } = await import("node:fs");
        const { gunzipSync } = await import("node:zlib");
        const { LIVE_LOG_UUID, readRecordingMeta, readUuidBox } = await import("../src/vision/mp4Mux.ts");
        const buf = new Uint8Array(readFileSync(file));
        const meta = readRecordingMeta(buf);
        const box = readUuidBox(buf, LIVE_LOG_UUID);
        const live = box ? JSON.parse((box[0] === 0x1f ? gunzipSync(box) : Buffer.from(box)).toString("utf8")) : null;
        const frames = live?.log?.segments?.reduce((n, s) => n + s.readings.length, 0) ?? 0;
        const sameSolve = !!meta?.pair?.solveId && meta.pair.solveId === live?.pair?.solveId && meta.pair.solveId === meta.analysis?.live?.solveId && meta.solve?.id === meta.pair.solveId;
        const nameOk = /^cubevision-\d{8}-\d{6}-(\d+\.\d{2}s|DNF)(-partial|-failed)?\.mp4$/.test(dl.suggestedFilename());
        const bOk = !!meta?.summary && !!meta?.analysis?.result && frames > 0 && sameSolve && nameOk && !pathNg(meta.framePath);
        console.log(`  bundle: ${file}（${(buf.byteLength / 1e6).toFixed(1)}MB）${bOk ? "OK" : "NG"}・要約 ${meta?.summary ? "あり" : "なし"}・解析の結果 ${meta?.analysis?.result ? "あり" : "なし"}・ライブの記録 ${frames} 枚（区切り ${live?.log?.segments?.length ?? 0}・${live?.log?.from !== undefined ? `${(live.log.from / 1000).toFixed(1)}s から` : "-"}）・同じソルブの組 ${sameSolve ? "はい" : "いいえ"}・名前 ${nameOk ? "OK" : "NG"}`);
        if (!bOk) failures++;
        if (process.env.E2E_EXPORT_CHECK) {
          const run = (test, env, pick) =>
            new Promise((resolve) => {
              const p = spawn("npx", ["vitest", "run", "-c", "vitest.debug.config.ts", test, "--silent=false"], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
              let text = "";
              p.stdout.on("data", (d) => (text += d));
              p.stderr.on("data", (d) => (text += d));
              p.on("close", (c) => {
                for (const l of text.split("\n").filter((l) => pick.test(l))) console.log(`  ${l.trim()}`);
                resolve(c);
              });
            });
          const c1 = await run("tests/debug/realVideo.debug.test.ts", { REAL_VIDEO: file, REAL_EXPECT_SAME: "1" }, /書き出した録画|アプリの結果|^  (手順|stopCut|start|end|method|solved|inferred|手の時刻)/);
          console.log(`  bundle check realVideo: ${c1 === 0 ? "OK" : `NG（終了コード ${c1}）`}`);
          const outFile = `${dir}/seed${seed}-livelog.jsonl`;
          const { rmSync } = await import("node:fs");
          rmSync(outFile, { force: true });
          const c2 = await run("tests/debug/liveLog.debug.test.ts", { LIVE_LOG: file, LIVE_LOG_OUT: outFile }, /まとめたファイル|正解|再生: |3D が精密解析と同じ|区切り \d/);
          const segs = readFileSync(outFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
          const same = segs.reduce((n, s) => n + s.same, 0);
          const differ = segs.reduce((n, s) => n + s.differ, 0);
          const m3 = segs.find((s) => s.match3d !== null)?.match3d;
          const lOk = c2 === 0 && same > 0 && differ === 0 && m3 !== undefined;
          console.log(`  bundle check liveLog: ${lOk ? "OK" : "NG"}（実機と同じ ${same}・違う ${differ}・3D の一致 ${m3 ?? "-"}%）`);
          if (c1 !== 0 || !lOk) failures++;
        }
      }
      if (process.env.E2E_LIVELOG) {
        const dir = process.env.E2E_LIVELOG;
        mkdirSync(dir, { recursive: true });
        await page.evaluate(() => window.__cubevision.store.set({ screen: "settings" }));
        const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.getByRole("button", { name: "ライブの記録を書き出す" }).click()]);
        const file = `${dir}/seed${seed}-${dl.suggestedFilename()}`;
        await dl.saveAs(file);
        console.log(`  live log: ${file}`);
        await page.evaluate(() => window.__cubevision.store.set({ screen: "play" }));
      }
      if (process.env.E2E_EXPORT) {
        const dir = process.env.E2E_EXPORT;
        mkdirSync(dir, { recursive: true });
        await page.evaluate(() => window.__cubevision.store.set({ screen: "settings" }));
        const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.getByRole("button", { name: "録画を書き出す" }).click()]);
        const file = `${dir}/seed${seed}-${dl.suggestedFilename()}`;
        await dl.saveAs(file);
        console.log(`  export: ${file}`);
        {
          const { readFileSync } = await import("node:fs");
          const { readRecordingMeta } = await import("../src/vision/mp4Mux.ts");
          const fp = readRecordingMeta(new Uint8Array(readFileSync(file)))?.framePath;
          console.log(`  書き出しの framePath: ${JSON.stringify(fp)}`);
          if (!fp || pathNg(fp)) {
            console.log("  書き出しの framePath: NG");
            failures++;
          }
        }
        if (process.env.E2E_EXPORT_CHECK) {
          const env = { ...process.env, REAL_VIDEO: file, REAL_EXPECT_SAME: "1", ...(process.env.E2E_EXPORT_STATS ? { REAL_STATS_OUT: process.env.E2E_EXPORT_STATS, REAL_STATS_LABEL: "合成（E2E）", REAL_NAME: `seed${seed}` } : {}) };
          const code = await new Promise((resolve) => {
            const p = spawn("npx", ["vitest", "run", "-c", "vitest.debug.config.ts", "tests/debug/realVideo.debug.test.ts", "--silent=false"], { env, stdio: ["ignore", "pipe", "pipe"] });
            let text = "";
            p.stdout.on("data", (d) => (text += d));
            p.stderr.on("data", (d) => (text += d));
            p.on("close", (c) => {
              for (const l of text.split("\n").filter((l) => /書き出した録画|時刻は録画|本体の復号|アプリの結果|読める量|^  (手順|stopCut|start|end|method|solved|inferred|手の時刻)/.test(l))) console.log(`  ${l.trim()}`);
              resolve(c);
            });
          });
          if (code !== 0) {
            console.log(`  export check: NG（終了コード ${code}）`);
            failures++;
          } else console.log("  export check: OK");
        }
      }
      if (!ok || process.env.E2E_TRACK) {
        // NG のとき: 終わった後のライブの追跡の様子（揃っていると見ているか・作り変えたか）
        const tr = await page.evaluate(() => {
          const t = window.__cubevision.store.get().track;
          return t && { status: t.status, solved: t.solved, obsCost: t.obsCost, moves: t.moves.length, base: t.base && { n: t.base.n, at: t.base.at }, faces: t.observation.faces.map((f) => f.labels.join("")) };
        });
        console.log(`  track after: ${JSON.stringify(tr)}`);
        console.log(logs.filter((l) => l.includes("[snap]")).slice(-12).join("\n"));
      }
      if (process.env.E2E_LOGS) console.log(logs.filter((l) => new RegExp(process.env.E2E_LOGS).test(l)).slice(-20).join("\n"));
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
        processed: app.vision?.processed,
        skipped: app.vision?.skipped,
      };
    });
    const a = canonical(r.decoded);
    const b = canonical(r.truth);
    const acc = 1 - editDistance(a, b) / Math.max(1, b.length);
    const finalOk = r.synthState.join() === r.trackState.join();
    const orientOk = r.trackOrient === r.synthOrient;
    results.push({ seed, acc, finalOk, scanSec });
    console.log(`seed ${seed}: scan ${scanSec.toFixed(1)}s  accuracy ${(acc * 100).toFixed(1)}%  final ${finalOk ? "OK" : "NG"}  orient ${orientOk ? "OK" : `NG(${r.trackOrient}/${r.synthOrient})`}  status ${r.status}  obs ${r.observations}  recov ${r.recoveries}  inferred ${r.inferred}  camFps ${r.stats.camFps} procFps ${r.stats.procFps} procMs ${r.stats.procMs.toFixed(1)}  処理 ${r.processed} 枚（選ばず ${r.skipped} 枚）`);
    console.log(`  ${await turnStats(page)}`);
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

// フェーズ0追加検証: 色付き ArUco ステッカーのテストモード。
// スマホのスロー撮影（240fps）で撮った動画を読み込み、1 フレームずつ検出して、方式 × 色 × 大きさの検出率を出す。
// 解析はすべて端末内（Worker）。動画はどこにも送らない。
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { DEFAULT_CONFIGS, type DetectorConfig, PARAM_KEYS, TUNED_PARAMS } from "./detect";
import type { FromArucoWorker, VideoInfo } from "./protocol";
import { type FrameRecord, SPEED_LABELS, type Summary, colorLabel, summarize, toCsv, toMarkdown } from "./stats";
import { SHEETS } from "./stickers";

const PASS_RATE = 0.9;

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const rateClass = (v: number) => (v >= PASS_RATE ? "ok" : v >= 0.7 ? "warn" : "bad");

export function ArucoPage() {
  const workerRef = useRef<Worker | null>(null);
  const framesRef = useRef<FrameRecord[]>([]);
  const [ready, setReady] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [sheetKey, setSheetKey] = useState("test");
  const [captureFps, setCaptureFps] = useState("");
  const [maxSide, setMaxSide] = useState(0);
  const [stride, setStride] = useState(1);
  const [enabled, setEnabled] = useState(DEFAULT_CONFIGS.map(() => true));
  const [tunedText, setTunedText] = useState(JSON.stringify(TUNED_PARAMS, null, 1));
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; elapsedMs: number } | null>(null);
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runConfigs, setRunConfigs] = useState<DetectorConfig[]>([]);
  const [version, setVersion] = useState(0); // 解析が終わる（止める）たびに増やす

  useEffect(() => {
    const w = new Worker(new URL("./aruco.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;
    w.onmessage = (e: MessageEvent<FromArucoWorker>) => {
      const m = e.data;
      if (m.type === "ready") setReady(m.ms);
      else if (m.type === "info") setInfo(m.info);
      else if (m.type === "frames") framesRef.current.push(...m.items);
      else if (m.type === "progress") setProgress({ done: m.done, total: m.total, elapsedMs: m.elapsedMs });
      else if (m.type === "done") {
        setRunning(false);
        setVersion((v) => v + 1);
      } else if (m.type === "error") {
        setRunning(false);
        setError(m.message);
        setVersion((v) => v + 1);
      }
    };
    w.postMessage({ type: "init" });
    return () => w.terminate();
  }, []);

  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setFileUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const tuned = useMemo(() => {
    try {
      const v = JSON.parse(tunedText);
      const out: Record<string, number> = {};
      for (const k of PARAM_KEYS) if (typeof v[k] === "number") out[k] = v[k];
      return { params: out, error: null as string | null };
    } catch (e) {
      return { params: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [tunedText]);

  const start = () => {
    if (!file || !workerRef.current || !tuned.params) return;
    const configs = DEFAULT_CONFIGS.filter((_, i) => enabled[i]).map((c) => (c.params === TUNED_PARAMS ? { ...c, params: tuned.params! } : c));
    if (!configs.length) return;
    framesRef.current = [];
    setRunConfigs(configs);
    setInfo(null);
    setProgress(null);
    setError(null);
    setRunning(true);
    setVersion((v) => v + 1);
    workerRef.current.postMessage({ type: "analyze", file, options: { configs, maxSide, stride } });
  };

  const sheet = SHEETS.find((s) => s.key === sheetKey)!;
  const fileFps = info?.fps ?? 0;
  const realFps = Number(captureFps) > 0 ? Number(captureFps) : fileFps;
  const timeScale = fileFps > 0 && realFps > 0 ? fileFps / realFps : 1;

  const summary = useMemo<Summary | null>(() => {
    if (running || !info || !framesRef.current.length) return null;
    return summarize({
      frames: framesRef.current,
      configs: runConfigs.map((c) => c.name),
      sheet,
      width: info.analyzedWidth,
      height: info.analyzedHeight,
      timeScale,
    });
  }, [version, running, info, sheet, timeScale, runConfigs]);

  // テスト（scripts/aruco-e2e.mjs）とデバッグ用
  useEffect(() => {
    (window as unknown as { __aruco?: unknown }).__aruco = { frames: framesRef.current, summary, info };
  }, [summary, info]);

  const meta = () => ({
    動画: file?.name ?? "",
    シート: sheet.label,
    コーデック: info?.codec ?? "",
    "大きさ（表示の向き）": info ? `${info.width}×${info.height}` : "",
    解析の大きさ: info ? `${info.analyzedWidth}×${info.analyzedHeight}` : "",
    ファイルのfps: fileFps.toFixed(1),
    撮影fps: realFps.toFixed(1),
    間引き: stride,
    端末: navigator.userAgent,
  });

  const etaS = progress && progress.done > 0 ? ((progress.total - progress.done) * progress.elapsedMs) / progress.done / 1000 : null;

  return (
    <div class="page aruco">
      <h2>ArUco ステッカー検証（テストモード）</h2>
      <p class="muted">
        スマホのスロー撮影（240fps）で撮った動画を読み込み、全フレームで色付き ArUco マーカーを検出して、方式 × 色 × 大きさごとの検出率を出します。
        解析はこの端末の中だけで行い、動画はどこにも送りません。
      </p>
      {ready === null && <div class="status-banner warn">OpenCV.js を読み込み中…</div>}

      <div class="card">
        <div class="card-head">1. 動画と条件</div>
        <div class="card-body form">
          <label>
            動画ファイル（MP4 / MOV）
            <input type="file" accept="video/*,.mov,.mp4" onChange={(e) => setFile((e.target as HTMLInputElement).files?.[0] ?? null)} />
          </label>
          <label>
            写したシート
            <select value={sheetKey} onChange={(e) => setSheetKey((e.target as HTMLSelectElement).value)}>
              {SHEETS.map((s) => (
                <option value={s.key}>{s.label}</option>
              ))}
            </select>
          </label>
          <p class="hint">
            テストページは黒い紙やキューブの上に切り抜いて置くと、実際のキューブと同じ条件になります。白い紙の上だと、赤・青は色の余白ごと 1 つの枠として検出されることがあります
            （大きさの判定もずれます）。
          </p>
          <label>
            実際の撮影 fps（空欄 = ファイルの値{fileFps ? `: ${fileFps.toFixed(1)}` : ""}）
            <input type="number" min="1" step="1" placeholder="例: 240" value={captureFps} onInput={(e) => setCaptureFps((e.target as HTMLInputElement).value)} />
          </label>
          <p class="hint">共有・書き出しでスロー再生の動画（30fps など）に変換されたときは、撮影した fps（240 など）を入れると時間を実時間に直します。</p>
          <div class="row2">
            <label>
              解析の解像度（長辺）
              <select value={maxSide} onChange={(e) => setMaxSide(Number((e.target as HTMLSelectElement).value))}>
                <option value={0}>原寸</option>
                <option value={1920}>1920</option>
                <option value={1280}>1280</option>
                <option value={960}>960</option>
              </select>
            </label>
            <label>
              間引き
              <select value={stride} onChange={(e) => setStride(Number((e.target as HTMLSelectElement).value))}>
                {[1, 2, 4, 8].map((n) => (
                  <option value={n}>{n === 1 ? "なし（全フレーム）" : `${n} フレームに 1 枚`}</option>
                ))}
              </select>
            </label>
          </div>
          <fieldset>
            <legend>比べる方式</legend>
            {DEFAULT_CONFIGS.map((c, i) => (
              <label class="check">
                <input type="checkbox" checked={enabled[i]} onChange={() => setEnabled(enabled.map((v, j) => (j === i ? !v : v)))} />
                {c.name}
              </label>
            ))}
            <details>
              <summary>調整版（c）のパラメータ</summary>
              <textarea rows={8} value={tunedText} onInput={(e) => setTunedText((e.target as HTMLTextAreaElement).value)} spellcheck={false} />
              {tuned.error && <div class="hint bad">JSON を読めません: {tuned.error}</div>}
              <div class="hint">使える項目: {PARAM_KEYS.join(", ")}</div>
            </details>
          </fieldset>
          <div class="btn-row">
            <button class="btn primary" disabled={!file || running || ready === null || !tuned.params || !enabled.some(Boolean)} onClick={start}>
              解析する
            </button>
            <button class="btn" disabled={!running} onClick={() => workerRef.current?.postMessage({ type: "cancel" })}>
              止める（ここまでで集計）
            </button>
          </div>
          {progress && (
            <div class="progress">
              <div class="bar">
                <div style={{ width: `${(100 * progress.done) / Math.max(1, progress.total)}%` }} />
              </div>
              <span>
                {progress.done} / {progress.total} フレーム（{(progress.elapsedMs / 1000).toFixed(0)} 秒
                {running && etaS !== null ? `、残り約 ${etaS.toFixed(0)} 秒` : ""}）
              </span>
            </div>
          )}
          {info && (
            <div class="hint">
              {info.codec}・{info.width}×{info.height}
              {info.rotation ? `（${info.rotation}° 回転）` : ""}・{info.samples} フレーム・ファイルの時刻で {info.fps.toFixed(1)} fps・解析 {info.analyzedWidth}×{info.analyzedHeight}
            </div>
          )}
          {error && <div class="status-banner bad">{error}</div>}
        </div>
      </div>

      {summary && <Results summary={summary} sheet={sheet} configs={runConfigs} meta={meta} />}
      {summary && fileUrl && info && <Viewer url={fileUrl} frames={framesRef.current} summary={summary} info={info} timeScale={timeScale} />}
    </div>
  );
}

function Results({ summary, sheet, configs, meta }: { summary: Summary; sheet: (typeof SHEETS)[number]; configs: DetectorConfig[]; meta: () => Record<string, string | number> }) {
  const colors = [...new Set(summary.groups.map((g) => g.color))];
  const passSize = sheet.sizes.includes(18) ? 18 : Math.max(...sheet.sizes);
  return (
    <div class="card section">
      <div class="card-head">
        2. 結果
        <span class="spacer" />
        <button class="btn small" onClick={() => download("aruco-result.csv", toCsv(summary, meta()), "text/csv")}>
          CSV
        </button>
        <button class="btn small" onClick={() => download("aruco-result.md", toMarkdown(summary, sheet, meta()), "text/markdown")}>
          Markdown
        </button>
      </div>
      <div class="card-body">
        <p class="muted">
          {summary.frames} フレーム（実時間 {(summary.durationMs / 1000).toFixed(2)} 秒・{summary.fps.toFixed(0)} fps 相当）。検出率は、そのマーカーを最初に読めてから最後に読めるまでの間のフレームに対する割合です。
        </p>
        <h3>方式の比較</h3>
        <div class="scroll">
          <table class="list">
            <thead>
              <tr>
                <th>方式</th>
                <th>{passSize}mm 全色 90% 以上</th>
                <th>全体の検出率</th>
                <th>処理時間 平均 / 95%</th>
                <th>誤検出</th>
              </tr>
            </thead>
            <tbody>
              {summary.configs.map((c, ci) => {
                const gs = summary.groups.filter((g) => g.config === ci && g.size === passSize && g.inRange > 0);
                const pass = gs.length > 0 && gs.every((g) => g.rate >= PASS_RATE);
                return (
                  <tr>
                    <td>{c.name}</td>
                    <td class={pass ? "ok" : "bad"}>{gs.length ? (pass ? "合格" : "不合格") : "—"}</td>
                    <td>{c.inRange ? pct(c.hits / c.inRange) : "—"}</td>
                    <td>
                      {c.msMean.toFixed(1)} / {c.msP95.toFixed(1)} ms
                    </td>
                    <td class={c.unexpected ? "warn" : ""}>{c.unexpected ? `${c.unexpected}（${c.unexpectedFrames} フレーム）` : "0"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <h3>色 × 大きさ（区間検出率）</h3>
        <p class="hint">下の段: 最も低かったマーカー・1 セルの画素数・コントラスト（グレー / max(RGB)）</p>
        {summary.configs.map((c, ci) => (
          <div class="scroll">
            <table class="list grid">
              <thead>
                <tr>
                  <th>{c.name}</th>
                  {sheet.sizes.map((z) => (
                    <th>{z}mm</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {colors.map((color) => (
                  <tr>
                    <td>{colorLabel(color)}</td>
                    {sheet.sizes.map((z) => {
                      const g = summary.groups.find((x) => x.config === ci && x.color === color && x.size === z);
                      if (!g || !g.inRange) return <td class="muted">—</td>;
                      return (
                        <td class={rateClass(g.rate)}>
                          <b>{pct(g.rate)}</b>
                          <small>
                            {pct(g.worstRate)}・{g.pxPerCell.toFixed(1)}px・{g.contrastGray}/{g.contrastMax}
                          </small>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

        <h3>動きの速さ別の検出率</h3>
        <p class="hint">速さはマーカーの 1 セル（辺の 1/6）を単位にした毎秒の移動量。56mm のキューブを 10 手/秒で回すと、ステッカーは 150〜200 マス/秒ほどで動きます。</p>
        <div class="scroll">
          <table class="list">
            <thead>
              <tr>
                <th>方式</th>
                {SPEED_LABELS.map((l) => (
                  <th>{l}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summary.configs.map((c) => (
                <tr>
                  <td>{c.name}</td>
                  {c.speed.map((b) => (
                    <td class={b.n ? rateClass(b.hits / b.n) : "muted"}>
                      {b.n ? pct(b.hits / b.n) : "—"}
                      {b.n ? <small>{b.n} フレーム</small> : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <details class="section">
          <summary>マーカーごとの結果</summary>
          <div class="scroll">
            <table class="list">
              <thead>
                <tr>
                  <th>方式</th>
                  <th>マーカー</th>
                  <th>大きさ</th>
                  <th>色</th>
                  <th>区間検出率</th>
                  <th>最長の途切れ</th>
                  <th>px/セル</th>
                  <th>コントラスト</th>
                </tr>
              </thead>
              <tbody>
                {summary.slots.map((s) => (
                  <tr>
                    <td>{configs[s.config]?.name}</td>
                    <td>{s.name}</td>
                    <td>{s.size}mm</td>
                    <td>
                      {s.rgb && <span class="swatch" style={{ background: `rgb(${s.rgb.join(",")})` }} />}
                      {colorLabel(s.color)}
                      {s.colorFromSpec ? "" : "（実測）"}
                    </td>
                    <td class={s.inRange ? rateClass(s.rateRange) : "muted"}>{s.inRange ? `${pct(s.rateRange)}（${s.hits}/${s.inRange}）` : "読めず"}</td>
                    <td>{s.longestGap ? `${s.longestGap} フレーム・${s.longestGapMs.toFixed(0)}ms` : "なし"}</td>
                    <td>{s.pxPerCell.toFixed(1)}</td>
                    <td>
                      {s.contrastGray} / {s.contrastMax}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </div>
  );
}

// 動画の上に、解析したフレームの検出結果を重ねる。動画の表示時刻にいちばん近い解析フレームを使う
function Viewer({ url, frames, summary, info, timeScale }: { url: string; frames: FrameRecord[]; summary: Summary; info: VideoInfo; timeScale: number }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timelineRef = useRef<HTMLCanvasElement>(null);
  const [config, setConfig] = useState(0);
  const [index, setIndex] = useState(0);
  const offsetRef = useRef<number | null>(null); // 動画の最初のフレームの mediaTime（秒）

  const nearest = (ms: number) => {
    let lo = 0;
    let hi = frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].t < ms) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(frames[lo - 1].t - ms) <= Math.abs(frames[lo].t - ms)) lo--;
    return lo;
  };

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    offsetRef.current = null;
    let handle = 0;
    const onFrame = (_now: number, meta: { mediaTime: number }) => {
      if (offsetRef.current === null) offsetRef.current = v.currentTime < 0.001 ? meta.mediaTime : 0;
      setIndex(nearest((meta.mediaTime - offsetRef.current) * 1000));
      handle = v.requestVideoFrameCallback(onFrame);
    };
    const rvfc = typeof v.requestVideoFrameCallback === "function";
    if (rvfc) handle = v.requestVideoFrameCallback(onFrame);
    // requestVideoFrameCallback がないブラウザは timeupdate で（粗い）
    const onTime = () => {
      if (!rvfc) setIndex(nearest(v.currentTime * 1000));
    };
    v.addEventListener("timeupdate", onTime);
    return () => {
      if (rvfc) v.cancelVideoFrameCallback(handle);
      v.removeEventListener("timeupdate", onTime);
    };
  }, [url, frames]);

  const seek = (i: number) => {
    const v = videoRef.current;
    if (!v || !frames.length) return;
    const k = Math.max(0, Math.min(frames.length - 1, i));
    v.pause();
    // フレームの途中の時刻にして、隣のフレームに丸められないようにする
    v.currentTime = (offsetRef.current ?? 0) + frames[k].t / 1000 + 0.25 / Math.max(1, info.fps);
    setIndex(k);
  };

  const slots = summary.slots.filter((s) => s.config === config);
  const firstSlot = summary.slots.findIndex((s) => s.config === config);

  // 重ね描き
  useEffect(() => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c) return;
    const draw = () => {
      const w = v.clientWidth;
      const h = v.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const f = frames[index];
      if (!f) return;
      const k = Math.min(w / info.analyzedWidth, h / info.analyzedHeight);
      const ox = (w - info.analyzedWidth * k) / 2;
      const oy = (h - info.analyzedHeight * k) / 2;
      const markers = f.results[config]?.markers ?? [];
      const assign = summary.slotOf[config]?.[index];
      ctx.font = "600 12px system-ui, sans-serif";
      markers.forEach((m, mi) => {
        const slot = assign && assign[mi] >= 0 ? summary.slots[assign[mi]] : null;
        const p = [0, 1, 2, 3].map((i) => [ox + m.corners[i * 2] * k, oy + m.corners[i * 2 + 1] * k]);
        ctx.strokeStyle = slot ? "#33c27f" : "#ffb020";
        ctx.lineWidth = 2;
        ctx.beginPath();
        p.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.stroke();
        // 上辺（マーカーの向き）
        ctx.strokeStyle = "#4f8cff";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(p[0][0], p[0][1]);
        ctx.lineTo(p[1][0], p[1][1]);
        ctx.stroke();
        const cx = p.reduce((a, q) => a + q[0], 0) / 4;
        const cy = p.reduce((a, q) => a + q[1], 0) / 4;
        const label = slot ? `${slot.name} ${slot.size}` : `#${m.id}?`;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = "rgba(0,0,0,0.65)";
        ctx.fillRect(cx - tw / 2 - 3, cy - 8, tw + 6, 16);
        ctx.fillStyle = "#fff";
        ctx.fillText(label, cx - tw / 2, cy + 4);
      });
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(v);
    return () => ro.disconnect();
  }, [index, config, frames, summary, info]);

  // タイムライン: 行 = マーカー、列 = フレーム（緑 = 読めた、赤 = 読めない、空 = 区間外）
  useEffect(() => {
    const c = timelineRef.current;
    if (!c) return;
    const rowH = slots.length > 20 ? 4 : 10;
    const w = c.clientWidth || 600;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr);
    c.height = Math.round(slots.length * rowH * dpr);
    c.style.height = `${slots.length * rowH}px`;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, slots.length * rowH);
    const n = frames.length;
    for (let x = 0; x < w; x++) {
      const a = Math.floor((x * n) / w);
      const b = Math.max(a + 1, Math.floor(((x + 1) * n) / w));
      slots.forEach((s, r) => {
        let miss = 0;
        let hit = 0;
        for (let i = a; i < b && i < n; i++) {
          if (s.track[i] === 1) miss++;
          else if (s.track[i] === 2) hit++;
        }
        if (!miss && !hit) return;
        ctx.fillStyle = miss ? "#ff5468" : "#33c27f";
        ctx.fillRect(x, r * rowH, 1, rowH - 1);
      });
    }
    ctx.fillStyle = "#4f8cff";
    ctx.fillRect(Math.floor((index * w) / Math.max(1, n)), 0, 2, slots.length * rowH);
  }, [index, config, frames, summary]);

  const nextMiss = (dir: 1 | -1) => {
    for (let i = index + dir; i >= 0 && i < frames.length; i += dir) {
      if (slots.some((s) => s.track[i] === 1)) return seek(i);
    }
  };
  const missedHere = slots.filter((s) => s.track[index] === 1);
  const f = frames[index];

  return (
    <div class="card section">
      <div class="card-head">
        3. 動画で確かめる
        <span class="spacer" />
        <select value={config} onChange={(e) => setConfig(Number((e.target as HTMLSelectElement).value))}>
          {summary.configs.map((c, i) => (
            <option value={i}>{c.name}</option>
          ))}
        </select>
      </div>
      <div class="card-body">
        <div class="viewer">
          <video ref={videoRef} src={url} controls playsInline muted preload="auto" />
          <canvas ref={canvasRef} />
        </div>
        <div class="btn-row section">
          <button class="btn small" onClick={() => seek(index - 1)}>
            ◀ 1 フレーム
          </button>
          <button class="btn small" onClick={() => seek(index + 1)}>
            1 フレーム ▶
          </button>
          <button class="btn small" onClick={() => nextMiss(-1)}>
            ◀ 前の見逃し
          </button>
          <button class="btn small" onClick={() => nextMiss(1)}>
            次の見逃し ▶
          </button>
          {[0.25, 1].map((r) => (
            <button
              class="btn small"
              onClick={() => {
                const v = videoRef.current;
                if (v) {
                  v.playbackRate = r;
                  void v.play();
                }
              }}
            >
              {r}× で再生
            </button>
          ))}
        </div>
        <p class="hint">
          フレーム {index + 1} / {frames.length}・{f ? ((f.t * timeScale) / 1000).toFixed(3) : "—"} 秒（実時間）・検出 {f?.results[config]?.markers.length ?? 0} 個・
          {f ? `${f.results[config]?.ms.toFixed(1)}ms` : ""}
          {missedHere.length ? `・読めなかった: ${missedHere.map((s) => `${s.name} ${s.size}mm`).join("、")}` : ""}
        </p>
        <p class="hint">緑の枠 = シートのマーカー、橙 = シートにない ID（誤検出）、青い太線 = マーカーの上辺。</p>
        <canvas
          ref={timelineRef}
          class="timeline"
          onClick={(e) => {
            const c = e.currentTarget as HTMLCanvasElement;
            const r = c.getBoundingClientRect();
            seek(Math.floor(((e.clientX - r.left) / r.width) * frames.length));
          }}
        />
        <p class="hint">
          タイムライン（{config + 1} 番目の方式、行 = マーカー {firstSlot >= 0 ? `${slots.length} 個` : ""}）: 緑 = 読めた、赤 = 読めなかった。クリックでその時刻へ。
        </p>
      </div>
    </div>
  );
}

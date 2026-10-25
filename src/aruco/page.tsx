// フェーズ0追加検証: 色付き ArUco ステッカー。スマホのスロー撮影（240fps）で撮った動画を読み込み、1 フレームずつ検出する。
//   キューブモード: ステッカーを貼ったキューブを回した動画から、見えている面を組み立てて手順を推定する
//   テストモード: シートを写した動画で、方式 × 色 × 大きさの検出率を出す
// 解析はすべて端末内（Worker）。動画はどこにも送らない。
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { CubeResult, VisibleFace } from "./cube";
import { CubeResults } from "./cubePanel";
import { DEFAULT_CONFIGS, type DetectorConfig, PARAM_KEYS, TUNED_PARAMS } from "./detect";
import type { FromArucoWorker, VideoInfo } from "./protocol";
import { type FrameRecord, SPEED_LABELS, type Summary, colorLabel, summarize, toCsv, toMarkdown } from "./stats";
import { SHEETS } from "./stickers";
import { Viewer } from "./viewer";

type Mode = "cube" | "sheet";

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
  const [mode, setMode] = useState<Mode>("cube");
  const [runMode, setRunMode] = useState<Mode>("cube");
  const [cubeConfig, setCubeConfig] = useState(1); // max(RGB)。調整版より合成のキューブで多く読めた
  const [endSolved, setEndSolved] = useState(false);
  const [truth, setTruth] = useState("");
  const [cube, setCube] = useState<{ faces: VisibleFace[][]; result: CubeResult } | null>(null);
  const [cubeBusy, setCubeBusy] = useState(false);

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
      } else if (m.type === "cube") {
        setCube({ faces: m.faces, result: m.result });
        setCubeBusy(false);
      } else if (m.type === "error") {
        setRunning(false);
        setCubeBusy(false);
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
    const chosen = mode === "cube" ? DEFAULT_CONFIGS.filter((_, i) => i === cubeConfig) : DEFAULT_CONFIGS.filter((_, i) => enabled[i]);
    const configs = chosen.map((c) => (c.params === TUNED_PARAMS ? { ...c, params: tuned.params! } : c));
    if (!configs.length) return;
    framesRef.current = [];
    setRunConfigs(configs);
    setRunMode(mode);
    setCube(null);
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
    if (runMode !== "sheet" || running || !info || !framesRef.current.length) return null;
    return summarize({
      frames: framesRef.current,
      configs: runConfigs.map((c) => c.name),
      sheet,
      width: info.analyzedWidth,
      height: info.analyzedHeight,
      timeScale,
    });
  }, [version, running, info, sheet, timeScale, runConfigs, runMode]);

  // キューブモード: 解析が終わったら（終わりの状態・撮影 fps を変えたら）面を組み立てて手順を推定する
  useEffect(() => {
    if (runMode !== "cube" || running || !info || !framesRef.current.length || !workerRef.current) return;
    setCubeBusy(true);
    workerRef.current.postMessage({ type: "cube", config: 0, endSolved, timeScale });
  }, [version, running, info, runMode, endSolved, timeScale]);

  // テスト（scripts/aruco-e2e.mjs）とデバッグ用
  useEffect(() => {
    (window as unknown as { __aruco?: unknown }).__aruco = { frames: framesRef.current, summary, info, cube };
  }, [summary, info, cube]);

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
      <h2>ArUco ステッカー検証</h2>
      <p class="muted">
        スマホのスロー撮影（240fps）で撮った動画を読み込み、全フレームで色付き ArUco マーカーを検出します。解析はこの端末の中だけで行い、動画はどこにも送りません。
      </p>
      <div class="seg">
        <button class={mode === "cube" ? "on" : ""} onClick={() => setMode("cube")}>
          キューブ（回した手順を推定）
        </button>
        <button class={mode === "sheet" ? "on" : ""} onClick={() => setMode("sheet")}>
          テスト（シートの検出率）
        </button>
      </div>
      {ready === null && <div class="status-banner warn">OpenCV.js を読み込み中…</div>}

      <div class="card">
        <div class="card-head">1. 動画と条件</div>
        <div class="card-body form">
          <label>
            動画ファイル（MP4 / MOV）
            <input type="file" accept="video/*,.mov,.mp4" onChange={(e) => setFile((e.target as HTMLInputElement).files?.[0] ?? null)} />
          </label>
          {mode === "sheet" ? (
            <>
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
            </>
          ) : (
            <>
              <p class="hint">
                揃った状態から回し始めた動画にしてください（最初の状態を揃った状態として推定します）。白を上・緑を正面に持つと、色基準の表記が普段の表記と同じになります。
              </p>
              <label class="check">
                <input type="checkbox" checked={endSolved} onChange={() => setEndSolved(!endSolved)} />
                最後は揃った状態（T-perm を 2 回など。最後の状態からも逆向きにたどって、より正確になります）
              </label>
            </>
          )}
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
            <legend>{mode === "cube" ? "検出の方式" : "比べる方式"}</legend>
            {DEFAULT_CONFIGS.map((c, i) =>
              mode === "cube" ? (
                <label class="check">
                  <input type="radio" name="cubeConfig" checked={cubeConfig === i} onChange={() => setCubeConfig(i)} />
                  {c.name}
                  {i === 1 ? "（おすすめ）" : ""}
                </label>
              ) : (
                <label class="check">
                  <input type="checkbox" checked={enabled[i]} onChange={() => setEnabled(enabled.map((v, j) => (j === i ? !v : v)))} />
                  {c.name}
                </label>
              ),
            )}
            <details>
              <summary>調整版（c）のパラメータ</summary>
              <textarea rows={8} value={tunedText} onInput={(e) => setTunedText((e.target as HTMLTextAreaElement).value)} spellcheck={false} />
              {tuned.error && <div class="hint bad">JSON を読めません: {tuned.error}</div>}
              <div class="hint">使える項目: {PARAM_KEYS.join(", ")}</div>
            </details>
          </fieldset>
          <div class="btn-row">
            <button class="btn primary" disabled={!file || running || ready === null || !tuned.params || (mode === "sheet" && !enabled.some(Boolean))} onClick={start}>
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

      {runMode === "cube" && cubeBusy && <div class="status-banner warn section">面を組み立てて手順を推定しています…</div>}
      {runMode === "cube" && cube && <CubeResults result={cube.result} truthText={truth} onTruth={setTruth} />}
      {runMode === "cube" && cube && fileUrl && info && (
        <Viewer url={fileUrl} frames={framesRef.current} info={info} timeScale={timeScale} configNames={runConfigs.map((c) => c.name)} cube={cube} />
      )}
      {summary && <Results summary={summary} sheet={sheet} configs={runConfigs} meta={meta} />}
      {summary && fileUrl && info && <Viewer url={fileUrl} frames={framesRef.current} info={info} timeScale={timeScale} configNames={runConfigs.map((c) => c.name)} summary={summary} />}
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

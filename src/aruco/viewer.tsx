// 動画の上に、解析したフレームの検出結果を重ねる。動画の表示時刻にいちばん近い解析フレームを使う。
// テストモード: マーカーごとの読めた・読めない。キューブモード: 組み立てた面と推定した手
import { useEffect, useRef, useState } from "preact/hooks";
import { MOVE_NAMES } from "../cube/model";
import { applyH } from "../vision/homography";
import { estimatePose } from "../vision/pose";
import { TimedCube3D } from "./timedCube";
import type { CubeFrame, CubeResult, VisibleFace } from "./cube";
import { FaceNet, SLOT_NAMES, heldName } from "./cubePanel";
import type { VideoInfo } from "./protocol";
import type { FrameRecord, Summary } from "./stats";
import { type StickerScheme, decode } from "./codes";
import { markerLabel } from "./stickers";

export interface ViewerProps {
  url: string;
  frames: FrameRecord[];
  info: VideoInfo;
  timeScale: number;
  configNames: string[];
  scheme: StickerScheme;
  summary?: Summary;
  cube?: { faces: VisibleFace[][]; turns?: CubeFrame["turn"][]; result: CubeResult };
}

// 回している層の外側の面（カメラフレーム）。軸の正の向きのまわりの角度で出す
const TURN_SLOT = ["上", "右", "正面", "下", "左", "背面"];

export function Viewer({ url, frames, info, timeScale, configNames, scheme, summary, cube }: ViewerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timelineRef = useRef<HTMLCanvasElement>(null);
  const [config, setConfig] = useState(0);
  const [index, setIndex] = useState(0);
  const [realMs, setRealMs] = useState(0); // 表示中のフレームの実時間（3D を動画に合わせる）
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
      setRealMs((meta.mediaTime - offsetRef.current) * 1000 * timeScale);
      handle = v.requestVideoFrameCallback(onFrame);
    };
    const rvfc = typeof v.requestVideoFrameCallback === "function";
    if (rvfc) handle = v.requestVideoFrameCallback(onFrame);
    // requestVideoFrameCallback がないブラウザは timeupdate で（粗い）
    const onTime = () => {
      if (!rvfc) {
        setIndex(nearest(v.currentTime * 1000));
        setRealMs(v.currentTime * 1000 * timeScale);
      }
    };
    v.addEventListener("timeupdate", onTime);
    return () => {
      if (rvfc) v.cancelVideoFrameCallback(handle);
      v.removeEventListener("timeupdate", onTime);
    };
  }, [url, frames, timeScale]);

  const seek = (i: number) => {
    const v = videoRef.current;
    if (!v || !frames.length) return;
    const k = Math.max(0, Math.min(frames.length - 1, i));
    v.pause();
    // フレームの途中の時刻にして、隣のフレームに丸められないようにする
    v.currentTime = (offsetRef.current ?? 0) + frames[k].t / 1000 + 0.25 / Math.max(1, info.fps);
    setIndex(k);
    setRealMs(frames[k].t * timeScale);
  };
  const seekReal = (ms: number) => seek(nearest(ms / timeScale));

  const slots = summary ? summary.slots.filter((s) => s.config === config) : [];
  const faces = cube?.faces[index] ?? [];
  const nowReal = (frames[index]?.t ?? 0) * timeScale;

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
      const P = (x: number, y: number): [number, number] => [ox + x * k, oy + y * k];
      const label = (text: string, x: number, y: number, bg = "rgba(0,0,0,0.65)") => {
        const tw = ctx.measureText(text).width;
        ctx.fillStyle = bg;
        ctx.fillRect(x - tw / 2 - 3, y - 8, tw + 6, 16);
        ctx.fillStyle = "#fff";
        ctx.fillText(text, x - tw / 2, y + 4);
      };
      ctx.font = "600 12px system-ui, sans-serif";
      // キューブモード: 組み立てた面の外枠
      for (const face of cube?.faces[index] ?? []) {
        const p = face.outline.map(([x, y]) => P(x, y));
        ctx.strokeStyle = "#e040fb";
        ctx.lineWidth = 3;
        ctx.beginPath();
        p.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.stroke();
        label(SLOT_NAMES[face.slot], p[0][0] + 16, p[0][1] - 10, "rgba(160,30,180,0.85)");
        // 回している途中の層（外側の 1 列）は別の格子（橙）
        if (face.layer) {
          const [x0, y0, x1, y1] = face.layer.rect;
          const q = ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as [number, number][]).map(([u, v]) => P(...applyH(face.layer!.H, u, v)));
          ctx.strokeStyle = "#ffa000";
          ctx.beginPath();
          q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.closePath();
          ctx.stroke();
        }
      }
      const markers = f.results[config]?.markers ?? [];
      const assign = summary?.slotOf[config]?.[index];
      // 回している途中の層のマーカー（回転途中の形状認識）は橙
      const turning = new Set(cube?.turns?.[index]?.ids ?? []);
      markers.forEach((m, mi) => {
        const slot = summary && assign && assign[mi] >= 0 ? summary.slots[assign[mi]] : null;
        const known = summary ? !!slot : !!decode(scheme, m.id);
        const p = [0, 1, 2, 3].map((i) => P(m.corners[i * 2], m.corners[i * 2 + 1]));
        ctx.strokeStyle = turning.has(m.id) ? "#ff6a00" : known ? "#33c27f" : "#ffb020";
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
        label(slot ? `${slot.name} ${slot.size}` : known ? markerLabel(scheme, m.id) : `#${m.id}?`, cx, cy);
      });
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(v);
    return () => ro.disconnect();
  }, [index, config, frames, summary, cube, info, scheme]);

  // タイムライン。テストモード: 行 = マーカー（緑 = 読めた、赤 = 読めない、空 = 区間外）。
  // キューブモード: 行 = 面（濃さ = 読めたマス）と、推定した手（青 = 見えた手、橙 = 推定した手）
  const rows = summary ? slots.length : cube ? 6 : 0;
  useEffect(() => {
    const c = timelineRef.current;
    if (!c || !rows) return;
    const rowH = rows > 20 ? 4 : 10;
    const w = c.clientWidth || 600;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr);
    c.height = Math.round(rows * rowH * dpr);
    c.style.height = `${rows * rowH}px`;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, rows * rowH);
    const n = frames.length;
    for (let x = 0; x < w; x++) {
      const a = Math.floor((x * n) / w);
      const b = Math.max(a + 1, Math.floor(((x + 1) * n) / w));
      if (summary) {
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
      } else if (cube) {
        for (let slot = 0; slot < 5; slot++) {
          let known = 0;
          for (let i = a; i < b && i < n; i++) known = Math.max(known, cube.faces[i]?.find((f) => f.slot === slot)?.colors.filter((c) => c >= 0).length ?? 0);
          if (!known) continue;
          ctx.fillStyle = `rgba(51,194,127,${0.25 + (0.75 * known) / 9})`;
          ctx.fillRect(x, slot * rowH, 1, rowH - 1);
        }
      }
    }
    if (cube && n) {
      const t0 = frames[0].t * timeScale;
      const t1 = frames[n - 1].t * timeScale || 1;
      const X = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * w;
      for (const m of cube.result.moves) {
        ctx.fillStyle = m.inferred ? "#ffb020" : "#4f8cff";
        const xa = X(m.t0 ?? m.t - 30);
        ctx.fillRect(xa, 5 * rowH, Math.max(2, X(m.t) - xa), rowH - 1);
      }
    }
    ctx.fillStyle = "#e040fb";
    ctx.fillRect(Math.floor((index * w) / Math.max(1, n)), 0, 2, rows * rowH);
  }, [index, config, frames, summary, cube, rows]);

  const nextMiss = (dir: 1 | -1) => {
    for (let i = index + dir; i >= 0 && i < frames.length; i += dir) {
      if (slots.some((s) => s.track[i] === 1)) return seek(i);
    }
  };
  const moves = cube?.result.moves ?? [];
  const nextMove = (dir: 1 | -1) => {
    const list = dir > 0 ? moves.filter((m) => (m.t0 ?? m.t) > nowReal + 1) : moves.filter((m) => (m.t0 ?? m.t) < nowReal - 1).reverse();
    if (list[0]) seekReal(list[0].t0 ?? list[0].t);
  };
  const doneMoves = moves.filter((m) => m.t <= nowReal);
  const turning = moves.find((m) => (m.t0 ?? m.t) <= nowReal && nowReal < m.t);
  // カメラに映ったキューブの傾き（組み立てた面の格子から。src/vision/pose.ts）
  const tilt = info && faces.length ? (estimatePose(faces.map((f) => ({ slot: f.slot, H: f.H, rot: 0, held: !!f.partial })), info.analyzedWidth, info.analyzedHeight)?.R ?? null) : null;
  const missedHere = slots.filter((s) => s.track[index] === 1);
  const f = frames[index];

  return (
    <div class="card section">
      <div class="card-head">
        3. 動画で確かめる
        <span class="spacer" />
        {configNames.length > 1 && (
          <select value={config} onChange={(e) => setConfig(Number((e.target as HTMLSelectElement).value))}>
            {configNames.map((c, i) => (
              <option value={i}>{c}</option>
            ))}
          </select>
        )}
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
          {summary && (
            <>
              <button class="btn small" onClick={() => nextMiss(-1)}>
                ◀ 前の見逃し
              </button>
              <button class="btn small" onClick={() => nextMiss(1)}>
                次の見逃し ▶
              </button>
            </>
          )}
          {cube && (
            <>
              <button class="btn small" onClick={() => nextMove(-1)}>
                ◀ 前の手
              </button>
              <button class="btn small" onClick={() => nextMove(1)}>
                次の手 ▶
              </button>
            </>
          )}
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
          フレーム {index + 1} / {frames.length}・{f ? (nowReal / 1000).toFixed(3) : "—"} 秒（実時間）・検出 {f?.results[config]?.markers.length ?? 0} 個・
          {f ? `${f.results[config]?.ms.toFixed(1)}ms` : ""}
          {missedHere.length ? `・読めなかった: ${missedHere.map((s) => `${s.name} ${s.size}mm`).join("、")}` : ""}
        </p>
        {cube && (
          <>
            <p class="hint">
              ここまでの手（{doneMoves.length}）: {doneMoves.map((m) => MOVE_NAMES[m.move]).join(" ") || "—"}
              {turning ? `・回している: ${MOVE_NAMES[turning.move]}（持ち方基準 ${heldName(turning)}）` : ""}
              {cube.turns?.[index] ? `・このフレームの形: ${TURN_SLOT[cube.turns[index]!.slot]}の層が ${Math.round((cube.turns[index]!.total * 180) / Math.PI)}°（橙の枠）` : ""}
            </p>
            <div class="cube-row">
              <FaceNet faces={faces} />
              {moves.length > 0 && (
                <div class="cube-3d">
                  <TimedCube3D moves={moves} time={realMs} held pose={tilt} />
                  <div class="hint">推定した手順で動かしたキューブ（動画の時刻までに回し始めた手を、決まった速さで 1 手ずつ回す・カメラに映ったキューブと同じ向き）</div>
                </div>
              )}
            </div>
          </>
        )}
        <p class="hint">
          {summary ? "緑の枠 = シートのマーカー、橙 = シートにない ID（誤検出）" : "緑の枠 = ステッカーのマーカー、紫の枠 = 組み立てた面"}、青い太線 = マーカーの上辺。
        </p>
        {rows > 0 && (
          <>
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
              {summary
                ? `タイムライン（行 = マーカー ${slots.length} 個）: 緑 = 読めた、赤 = 読めなかった。`
                : "タイムライン（行 = 上・右・正面・下・左の面、濃いほど多くのマスが読めた。最後の行 = 推定した手）。"}
              クリックでその時刻へ。
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// カメラ映像と、検出結果のオーバーレイ（格子・各セルの分類色・隠れたセル・デバッグ情報）
import { useEffect, useRef } from "preact/hooks";
import { controller } from "../app/controller";
import { settingsStore } from "../app/settings";
import { useStore } from "../app/store";
import { type Lab, NAMED_COLORS, colorDistance, nearestNamed } from "../vision/color";
import type { Pt } from "../vision/homography";
import { slotPoint } from "../vision/layout";
import type { FrameMessage } from "../vision/protocol";
import { SLOT_LABEL } from "./notation";

function classifyColor(lab: Lab, refs: Lab[] | null, display: string[] | null): string {
  if (refs && display) {
    let best = 0;
    refs.forEach((r, i) => {
      if (colorDistance(lab, r) < colorDistance(lab, refs[best])) best = i;
    });
    return colorDistance(lab, refs[best]) > 34 ? "rgba(0,0,0,0)" : display[best];
  }
  return NAMED_COLORS[nearestNamed(lab)].display;
}

export function CameraView() {
  const app = useStore(controller.store, (s) => ({ camera: s.camera, error: s.cameraError, demo: s.demo, scanning: !!s.scan && !s.scan.result, vision: s.vision }));
  const settings = useStore(settingsStore, (s) => ({ mirror: s.mirror, debug: s.debug }));
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const hint = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const video = controller.camera.video;
    video.className = "";
    host.current?.prepend(video);
    return () => video.remove();
  }, []);

  useEffect(() => {
    controller.camera.video.classList.toggle("mirror", settings.mirror && !app.demo);
  }, [settings.mirror, app.demo]);

  useEffect(() => {
    const draw = (m: FrameMessage) => {
      const c = canvas.current;
      const video = controller.camera.video;
      if (!c || !video.videoWidth) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = c.clientWidth;
      const H = c.clientHeight;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
        c.width = Math.round(W * dpr);
        c.height = Math.round(H * dpr);
      }
      const ctx = c.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      // object-fit: contain の表示領域
      const s = Math.min(W / m.width, H / m.height);
      const ox = (W - m.width * s) / 2;
      const oy = (H - m.height * s) / 2;
      const mirror = settingsStore.get().mirror && !controller.store.get().demo;
      const map = ([x, y]: Pt): Pt => [mirror ? ox + (m.width - x) * s : ox + x * s, oy + y * s];
      const st = controller.store.get();
      const track = st.track;
      const refs = track?.refs ?? st.cube?.refs ?? null;
      const display = st.cube?.display ?? null;
      const debug = settingsStore.get().debug;

      if (debug) {
        ctx.strokeStyle = "rgba(255,0,255,0.7)";
        ctx.lineWidth = 1;
        for (const q of m.quads) {
          ctx.beginPath();
          q.map(map).forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
          ctx.closePath();
          ctx.stroke();
        }
      }

      for (const face of m.faces) {
        const anchor = face.slot === 2;
        const outline = [slotPoint(face, 0, 0), slotPoint(face, 3, 0), slotPoint(face, 3, 3), slotPoint(face, 0, 3)].map(map);
        ctx.lineWidth = anchor ? 3 : 2;
        ctx.strokeStyle = anchor ? "rgba(111,211,255,0.95)" : "rgba(111,211,255,0.6)";
        ctx.beginPath();
        outline.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
        ctx.closePath();
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(111,211,255,0.45)";
        for (let i = 1; i < 3; i++) {
          ctx.beginPath();
          ctx.moveTo(...map(slotPoint(face, i, 0)));
          ctx.lineTo(...map(slotPoint(face, i, 3)));
          ctx.moveTo(...map(slotPoint(face, 0, i)));
          ctx.lineTo(...map(slotPoint(face, 3, i)));
          ctx.stroke();
        }
        // 各セルの分類色（小さな四角）
        for (let cell = 0; cell < 9; cell++) {
          const x = (cell % 3) + 0.5;
          const y = Math.floor(cell / 3) + 0.5;
          const pts = [slotPoint(face, x - 0.17, y - 0.17), slotPoint(face, x + 0.17, y - 0.17), slotPoint(face, x + 0.17, y + 0.17), slotPoint(face, x - 0.17, y + 0.17)].map(map);
          ctx.beginPath();
          pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
          ctx.closePath();
          if (face.valid[cell]) {
            ctx.fillStyle = classifyColor(face.labs[cell], refs, display);
            ctx.fill();
            ctx.lineWidth = 3;
            ctx.strokeStyle = "rgba(0,0,0,0.75)";
            ctx.stroke();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = "rgba(255,255,255,0.95)";
            ctx.stroke();
            ctx.lineWidth = 1;
          } else {
            ctx.strokeStyle = "rgba(255,84,104,0.9)";
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(...pts[0]);
            ctx.lineTo(...pts[2]);
            ctx.moveTo(...pts[1]);
            ctx.lineTo(...pts[3]);
            ctx.stroke();
            ctx.lineWidth = 1;
          }
        }
        // スキャン中: まだ読みがそろっていないマス（指で隠れているなど）を点線で示す
        const covered = st.scan && !st.scan.result && anchor ? st.scan.covered : undefined;
        if (covered && st.scan!.progress > 0.05) {
          ctx.setLineDash([5, 4]);
          ctx.strokeStyle = "rgba(255,176,32,0.95)";
          ctx.lineWidth = 2.5;
          for (let cell = 0; cell < 9; cell++) {
            if (covered[cell]) continue;
            const x = (cell % 3) + 0.5;
            const y = Math.floor(cell / 3) + 0.5;
            const pts = [slotPoint(face, x - 0.42, y - 0.42), slotPoint(face, x + 0.42, y - 0.42), slotPoint(face, x + 0.42, y + 0.42), slotPoint(face, x - 0.42, y + 0.42)].map(map);
            ctx.beginPath();
            pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
            ctx.closePath();
            ctx.stroke();
          }
          ctx.setLineDash([]);
          ctx.lineWidth = 1;
        }
        // 正面のラベルは下に（上面と重ならないように）
        if (!debug && !anchor) continue;
        const label = map(slotPoint(face, 1.5, anchor ? 3.3 : -0.3));
        ctx.font = "600 12px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(10,12,18,0.7)";
        const text = `${SLOT_LABEL[face.slot]}${debug ? ` ${face.found}/9` : ""}`;
        const tw = ctx.measureText(text).width + 12;
        ctx.fillRect(label[0] - tw / 2, label[1] - 10, tw, 18);
        ctx.fillStyle = "#fff";
        ctx.fillText(text, label[0], label[1] + 3);
      }

      if (debug) {
        ctx.font = "12px ui-monospace, monospace";
        ctx.textAlign = "left";
        ctx.fillStyle = "rgba(10,12,18,0.7)";
        ctx.fillRect(8, H - 26, 300, 20);
        ctx.fillStyle = "#9f9";
        ctx.fillText(`${m.width}x${m.height} 処理 ${m.procMs.toFixed(1)}ms 候補 ${m.quads.length} 面 ${m.faces.length}`, 14, H - 12);
      }

      if (hint.current) {
        const scanning = !!st.scan && !st.scan.result;
        let text = "";
        if (scanning) {
          const reason = st.scan?.reason;
          const hidden = st.scan?.covered ? st.scan.covered.filter((c) => !c).length : 0;
          text =
            reason === "duplicate"
              ? "その面はスキャン済みです。次の面を見せてください"
              : reason === "no-face"
                ? "面が見つかりません。キューブを枠いっぱいに近づけてください"
                : hidden && (st.scan?.progress ?? 0) > 0.5
                  ? `点線のマス（${hidden}）が読めていません。指をずらしてください`
                  : "そのまま動かさないでください…";
        } else if (st.cube && !m.faces.length) text = "キューブが見えていません";
        hint.current.textContent = text;
        hint.current.style.display = text ? "" : "none";
      }
    };
    return controller.onFrameResult(draw);
  }, []);

  return (
    <div class="camera" ref={host}>
      <canvas ref={canvas} />
      <div class="hint" ref={hint} style={{ display: "none" }} />
      {app.camera !== "on" && (
        <div class="placeholder">
          <div>
            <svg width="54" height="54" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
            {app.camera === "error" ? <p>{app.error}</p> : <p>カメラでキューブを映すと、回した手順を読み取って右の3Dキューブで再現します。</p>}
            <div class="btn-row" style={{ justifyContent: "center" }}>
              <button class="btn primary" onClick={() => controller.startCamera()} disabled={app.camera === "starting"}>
                {app.camera === "starting" ? "起動中…" : "カメラを開始"}
              </button>
              <button class="btn" onClick={() => controller.startDemo()}>
                デモで試す（カメラなし）
              </button>
            </div>
          </div>
        </div>
      )}
      {app.camera === "on" && app.vision === "loading" && (
        <div class="hint" style={{ top: 12, bottom: "auto" }}>
          画像認識エンジンを読み込み中…
        </div>
      )}
    </div>
  );
}

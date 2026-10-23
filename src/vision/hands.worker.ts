// MediaPipe Hand Landmarker（21点/手）を Worker で動かし、指に隠れたステッカーを読まないためのマスクを作る。
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

let landmarker: HandLandmarker | null = null;
let lastTs = 0;

type Msg = { type: "init"; wasmBase: string; modelUrls: string[] } | { type: "frame"; bitmap: ImageBitmap; t: number };

self.onmessage = async (e: MessageEvent<Msg>) => {
  const msg = e.data;
  const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
  if (msg.type === "init") {
    try {
      const fileset = await FilesetResolver.forVisionTasks(msg.wasmBase, true);
      let lastErr: unknown = null;
      for (const url of msg.modelUrls) {
        for (const delegate of ["GPU", "CPU"] as const) {
          try {
            landmarker = await HandLandmarker.createFromOptions(fileset, {
              baseOptions: { modelAssetPath: url, delegate },
              ...(delegate === "GPU" ? { canvas: new OffscreenCanvas(1, 1) } : {}),
              runningMode: "VIDEO",
              numHands: 2,
              minHandDetectionConfidence: 0.4,
              minHandPresenceConfidence: 0.4,
            });
            post({ type: "ready", delegate });
            return;
          } catch (err) {
            lastErr = err;
          }
        }
      }
      throw lastErr;
    } catch (err) {
      post({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  if (!landmarker) {
    msg.bitmap.close();
    post({ type: "hands", hands: [] });
    return;
  }
  try {
    lastTs = Math.max(lastTs + 1, Math.round(msg.t));
    const r = landmarker.detectForVideo(msg.bitmap, lastTs);
    post({ type: "hands", hands: r.landmarks.map((h) => h.map((p) => [p.x, p.y])) });
  } catch (err) {
    post({ type: "hands", hands: [], error: String(err) });
  } finally {
    msg.bitmap.close();
  }
};

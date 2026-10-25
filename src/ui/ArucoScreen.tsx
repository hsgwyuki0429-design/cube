// ArUco ステッカーの画面（src/aruco）。初めて開いたときに読み込み（OpenCV.js は解析用の Worker で読む）、
// その後は他の画面に移っても残す（解析を続け、結果も消えない）
import type { ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";
import { controller } from "../app/controller";
import { useStore } from "../app/store";

export function ArucoScreen({ active }: { active: boolean }) {
  const [Page, setPage] = useState<ComponentType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const camera = useStore(controller.store, (s) => ({ on: s.camera === "on", demo: s.demo }));
  useEffect(() => {
    if (!active || Page) return;
    import("../aruco/page")
      .then((m) => setPage(() => m.ArucoPage))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [active, Page]);
  if (!Page && !active) return null;
  return (
    <div style={{ display: active ? "contents" : "none" }}>
      {camera.on && !camera.demo && (
        <div class="page" style={{ paddingBottom: 0 }}>
          <div class="status-banner warn" style={{ marginBottom: 0 }}>
            カメラの追跡が裏で動いていると、動画の解析が遅くなります。{" "}
            <button class="btn small" onClick={() => controller.stopCamera()}>
              カメラを止める
            </button>
          </div>
        </div>
      )}
      {Page ? <Page /> : <div class="page muted">{error ? `読み込めませんでした: ${error}` : "読み込み中…"}</div>}
    </div>
  );
}

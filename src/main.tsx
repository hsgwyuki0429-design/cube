import { Component, type ComponentChildren, render } from "preact";
import { controller } from "./app/controller";
import { settingsStore } from "./app/settings";
import { timerStore } from "./app/timer";
import "./styles.css";
import { App } from "./ui/App";

// テストとデバッグ用の入口
declare global {
  interface Window {
    __cubevision?: typeof controller;
    __cubevisionTimer?: typeof timerStore;
    __cvMounted?: boolean;
    __cvBootError?: (reason?: string) => void;
  }
}

// 画面の描画中の例外で、画面全体が消えて真っ白にならないようにする
class ErrorBoundary extends Component<{ children: ComponentChildren }, { error: Error | null }> {
  state = { error: null as Error | null };
  componentDidCatch(error: Error) {
    console.error(error);
    this.setState({ error });
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div class="page">
        <div class="status-banner bad">
          <b>画面の表示中にエラーが起きました</b>
          <pre class="small" style={{ whiteSpace: "pre-wrap" }}>{`${error.message}\n${error.stack ?? ""}`.slice(0, 1500)}</pre>
          <button class="btn small" onClick={() => location.reload()}>
            再読み込み
          </button>
        </div>
      </div>
    );
  }
}

// カメラや Worker の準備に失敗しても、画面は出す（失敗の内容は各表示に出る）
try {
  controller.init();
} catch (e) {
  console.error("init failed", e);
}

window.__cubevision = controller;
window.__cubevisionTimer = timerStore;

const params = new URLSearchParams(location.search);
// テスト用: ?stickers=aruco で ArUco マーカーのキューブにする（デモの合成キューブもマーカー付きで描く）
if (params.get("stickers") === "aruco" || params.get("stickers") === "color") settingsStore.set({ stickers: params.get("stickers") as "aruco" | "color" });
if (params.has("demo")) {
  const e2e = params.get("demo") === "e2e";
  controller.startDemo({
    seed: Number(params.get("seed") ?? 0) || undefined,
    script: e2e
      ? {
          e2eMoves: Number(params.get("moves") ?? 30),
          tps: Number(params.get("tps") ?? 2),
          view: (params.get("view") as "top" | "corner" | "front") ?? "top",
          timer: params.has("timer"),
        }
      : {},
  });
}

const root = document.getElementById("app")!;
root.textContent = "";
render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
  root,
);
window.__cvMounted = true;

if (import.meta.env.PROD && "serviceWorker" in navigator && !params.has("demo")) {
  import("virtual:pwa-register").then(({ registerSW }) => registerSW({ immediate: true })).catch(() => undefined);
}

import { Component, type ComponentChildren, render } from "preact";
import { controller } from "./app/controller";
import { PHASE_LABEL, checkLastRun, markPhase } from "./app/crashGuard";
import { lowerRecordBitrate } from "./vision/recorder";
import { timerStore } from "./app/timer";
import "./styles.css";
import { App } from "./ui/App";
import { trackViewport } from "./ui/viewport";

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

trackViewport();

// カメラや Worker の準備に失敗しても、画面は出す（失敗の内容は各表示に出る）
try {
  controller.init();
} catch (e) {
  console.error("init failed", e);
}

// 前回は解析の途中で落ちた（iPhone でメモリが足りずにタブごと読み込み直された）: どこで落ちたかを出す
// 録画の画質も 1 段下げる（落ちた原因がメモリなら、録画を残す量が減る: src/vision/recorder.ts の「端末に合わせる」）
const crashed = checkLastRun();
if (crashed) lowerRecordBitrate();
if (crashed)
  setTimeout(
    () =>
      controller.toast(
        `前回は「${PHASE_LABEL[crashed.phase]}」の途中でアプリが落ちました。そのときのタイムは速報値のままです`,
        12000,
      ),
    500,
  );
// 閉じた・移動したときは印を消す（落ちたときだけ印が残る）
window.addEventListener("pagehide", () => markPhase(null));

window.__cubevision = controller;
window.__cubevisionTimer = timerStore;

const params = new URLSearchParams(location.search);
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

import { render } from "preact";
import { controller } from "./app/controller";
import "./app/timer";
import "./styles.css";
import { App } from "./ui/App";

controller.init();

// テストとデバッグ用の入口
declare global {
  interface Window {
    __cubevision?: typeof controller;
  }
}
window.__cubevision = controller;

const params = new URLSearchParams(location.search);
if (params.has("demo")) {
  const e2e = params.get("demo") === "e2e";
  controller.startDemo({
    seed: Number(params.get("seed") ?? 0) || undefined,
    script: e2e ? { e2eMoves: Number(params.get("moves") ?? 30), tps: Number(params.get("tps") ?? 2), view: (params.get("view") as "top" | "corner" | "front") ?? "top" } : {},
  });
}

render(<App />, document.getElementById("app")!);

if (import.meta.env.PROD && "serviceWorker" in navigator && !params.has("demo")) {
  import("virtual:pwa-register").then(({ registerSW }) => registerSW({ immediate: true })).catch(() => undefined);
}

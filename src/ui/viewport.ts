// 画面の大きさを CSS の変数（--app-h・--app-w）に入れておく。iPhone でアプリを閉じずに戻ると、100dvh が戻る前の大きさのまま
// 残り、カメラの画面が画面全体より狭くなっていた（スタックから消して入り直すと直る）。戻ったとき（visibilitychange・pageshow）・
// 大きさや向きが変わったときに、実際の大きさで測り直す。戻った直後は大きさがまだ変わっていることがあるので、少し後にもう一度測る
export function trackViewport(): void {
  const root = document.documentElement;
  const measure = () => {
    const vv = window.visualViewport;
    const h = Math.round(Math.max(window.innerHeight, vv ? vv.height + vv.offsetTop : 0));
    const w = Math.round(window.innerWidth);
    if (h > 0) root.style.setProperty("--app-h", `${h}px`);
    if (w > 0) root.style.setProperty("--app-w", `${w}px`);
  };
  const again = () => {
    measure();
    for (const ms of [100, 400, 1000]) setTimeout(measure, ms);
  };
  measure();
  window.addEventListener("resize", measure);
  window.addEventListener("orientationchange", again);
  window.addEventListener("pageshow", again);
  window.visualViewport?.addEventListener("resize", measure);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") again();
  });
}

// ?solveload=…: ソルブ中の重さの配り方（ライブ 2.5。docs/history.md の「ライブ 2.5」）。既定は vframe（実機の iPhone でソルブ中の
// カメラが 36〜38 → 52〜55fps）。カンマで組み合わせる:
//   default = vframe を使わない（2026-11-27 より前のやり方: ライブに送る画像・録画の画像をメインスレッドで作る）
//   pause = ソルブ中は精密解析に録画を渡さない（止めたらまとめて渡す。止めた後の待ちが延びる）
//   duty50 など = ソルブ中は精密解析の Worker が処理していた時間の割合を 50% までにする（同じフレームを遅れて処理する。結果は同じ）
//   helperoff = ソルブ中は認識の補助の Worker を休ませる（精密解析の Worker に CPU を回す）
//   lazy = 精密解析で、インスペクションの間引きで処理しないフレームを画素にしない（結果は同じ。復号の後の画素の取り出しを省く）
// vframe = カメラのフレームを VideoFrame のままライブの Worker と録画に渡す（縮める・描くのをメインスレッドでしない）。VideoFrame を
// 作れない・Worker に渡せない・Worker で描けない端末では、自動で今までのやり方に戻す（src/vision/visionClient.ts・recorder.ts）
export interface SolveLoad {
  refine: string; // full・pause・duty50 など
  helper: "on" | "off";
  lazy: boolean;
  vframe: boolean;
}

export function parseSolveLoad(q: string): SolveLoad {
  const parts = q.split(",").map((x) => x.trim()).filter(Boolean);
  const refine = parts.find((x) => x === "pause" || /^duty\d+$/.test(x)) ?? "full";
  return { refine, helper: parts.includes("helperoff") ? "off" : "on", lazy: parts.includes("lazy"), vframe: !parts.includes("default") };
}

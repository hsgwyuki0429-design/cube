// ArUco の検出の処理時間（ライブの解像度 1280×720 の合成のキューブ）と読めた数を、検出パラメータごとに比べる
import { it } from "vitest";
import { ArucoBench, type DetectorConfig } from "../../src/aruco/detect";
import { parseMoves } from "../../src/cube/model";
import { applyMoveStickers, renderArucoCube, solvedStickers } from "../arucoCube";
import { loadTestOpenCv } from "../cv";

it("速さ", async () => {
  const cv = await loadTestOpenCv();
  let st = solvedStickers();
  for (const m of parseMoves("R U F' D2 L")) st = applyMoveStickers(st, m);
  const imgs = [0, 1, 2, 3].map((k) => renderArucoCube(cv, { width: 1280, height: 720, stickers: st, orient: 0, eye: [2.4 + k * 0.4, 2.4, 6.5 + k], noise: 2, seed: k + 1, scheme: "aruco12", turn: k % 2 ? { move: parseMoves("U")[0], fraction: 0.5, spread: 0.12 } : undefined }));
  const configs: DetectorConfig[] = [
    { name: "既定", preprocess: "max", params: {} },
    { name: "窓 3〜23・5 刻み", preprocess: "max", params: { adaptiveThreshWinSizeStep: 5, adaptiveThreshWinSizeMax: 23 } },
    { name: "窓 3〜33・5 刻み", preprocess: "max", params: { adaptiveThreshWinSizeStep: 5, adaptiveThreshWinSizeMax: 33 } },
  ];
  for (const c of configs) {
    const b = new ArucoBench(cv, [c], "aruco12");
    b.detect(imgs[0]);
    let ms = 0;
    let n = 0;
    for (let rep = 0; rep < 3; rep++) for (const img of imgs) {
      const r = b.detect(img)[0];
      ms += r.ms;
      n += r.markers.length;
    }
    console.log(`R ${c.name}: ${(ms / 12).toFixed(1)}ms/フレーム・マーカー ${(n / 12).toFixed(1)} 個`);
    b.delete();
  }
});

// 合成のキューブ（本体と同じ 4 個の配置のステッカー）を本体の認識に通した、1 フレームの見え方（sight.ts の SightFrame）。
// タイマーの開始・停止を ID で見る判定のテスト（homeView・startDetect・stopDetect）
import { STICKERS, designOf } from "../src/aruco/design";
import { type Vec3, parseMoves } from "../src/cube/model";
import { type SightFrame, sightFrame } from "../src/track/sight";
import type { CV } from "../src/vision/image";
import { DEFAULT_PIPELINE, processFrame } from "../src/vision/pipeline";
import { applyMoveStickers, renderArucoCube, solvedStickers } from "./arucoCube";

export const EYES: Record<string, Vec3> = {
  three: [2.4, 2.4, 5.5], // 上・正面・右
  top: [0.3, 3.2, 5.5], // 上・正面
  side: [3.2, 0.3, 5.5], // 正面・右
  front: [0, 0, 6], // 正面だけ
};

const PIPELINE = { ...DEFAULT_PIPELINE, ...STICKERS };
const DESIGN = designOf(STICKERS.arucoDesign);

// moves: 揃った状態から回す手。t: フレームの時刻
export function sightOf(cv: CV, moves: string | number[], orient: number, eye: Vec3, t = 0): SightFrame {
  let st = solvedStickers();
  for (const m of typeof moves === "string" ? parseMoves(moves) : moves) st = applyMoveStickers(st, m);
  const img = renderArucoCube(cv, { width: 960, height: 720, stickers: st, orient, eye, noise: 2, scheme: "unique54", design: DESIGN });
  return sightFrame(t, processFrame(cv, img, t, PIPELINE, {}));
}

export const at = (s: SightFrame, t: number): SightFrame => ({ ...s, t });

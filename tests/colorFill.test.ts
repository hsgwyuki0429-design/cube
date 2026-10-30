// 色による補完（src/aruco/colorFill.ts）: 同じフレームのマーカーの色で分け、肌・どっちつかずの色は不明のまま。
// 指が一部にかかって読めなくなったマーカーのマスを、色で補う
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { COLOR_CONF, classifyByFrame, frameRefs } from "../src/aruco/colorFill";
import { hexRgb } from "../src/aruco/design";
import { ARUCO_REFS, PRINT_COLORS } from "../src/aruco/palette";
import { VIEW, type Vec3, parseMoves } from "../src/cube/model";
import { applyH } from "../src/vision/homography";
import { processAruco } from "../src/vision/arucoFrame";
import { type CV, initOpenCv } from "../src/vision/image";
import { applyMoveStickers, renderArucoCube, solvedStickers, stickerAt } from "./arucoCube";

let cv: CV;
beforeAll(async () => {
  cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
}, 120000);

describe("色による補完", () => {
  // 暖かい照明で少し黄色っぽく写ったときの 6 色
  const warm = PRINT_COLORS.map((h) => {
    const [r, g, b] = hexRgb(h);
    return [Math.min(255, r), Math.round(g * 0.95), Math.round(b * 0.8)] as [number, number, number];
  });
  const refs = frameRefs(warm.map((rgb, face) => ({ rgb, face })));

  it("フレームのマーカーの色に分ける。肌・2 色の中間は不明", () => {
    warm.forEach((rgb, face) => expect(classifyByFrame(rgb, refs)).toBe(face));
    expect(classifyByFrame([222, 170, 140], refs)).toBe(-1); // 肌
    const mid = [0, 1, 2].map((k) => Math.round((warm[1][k] + warm[4][k]) / 2)) as [number, number, number]; // 赤と橙の中間
    expect(classifyByFrame(mid, refs)).toBe(-1);
    // そのフレームに橙のマーカーがなければ、橙は赤にも黄にも寄せない
    const noOrange = refs.map((r, f) => (f === 4 ? null : r));
    expect(classifyByFrame(warm[4], noOrange)).toBe(-1);
  });

  it("指が角にかかって読めなくなったマスを、色で補う（確からしさは低い）", () => {
    let st = solvedStickers();
    for (const m of parseMoves("R U F' D2 L")) st = applyMoveStickers(st, m);
    const size = { width: 960, height: 720 };
    const eye: Vec3 = [2.4, 2.4, 5.5];
    const at = stickerAt(st);
    const clean = processAruco(cv, renderArucoCube(cv, { ...size, stickers: st, orient: 0, eye, noise: 2, scheme: "unique54" }), 0, {}, "unique54", false, { reread: 0 });
    const front = clean.faces.find((f) => f.slot === 2)!;
    // 正面の左上のマスの左上の角に指先（マスの 3 割ほど）
    const corner = applyH(front.H, 0.1, 0.1);
    const pitch = Math.hypot(...([0, 1].map((k) => applyH(front.H, 1, 0)[k] - applyH(front.H, 0, 0)[k]) as [number, number]));
    const fingers = [{ a: [corner[0] - pitch * 3, corner[1] - pitch * 2] as [number, number], b: [corner[0], corner[1]] as [number, number], width: pitch * 0.6 }];
    const img = renderArucoCube(cv, { ...size, stickers: st, orient: 0, eye, noise: 2, scheme: "unique54", fingers });
    const want = Math.floor(at[VIEW[2 * 9 + 0]] / 9);
    const without = processAruco(cv, img, 0, {}, "unique54", false, { reread: 0, colorFill: false }).faces.find((f) => f.slot === 2)!;
    expect(without.valid[0]).toBe(false);
    const withFill = processAruco(cv, img, 0, {}, "unique54", false, { reread: 0 }).faces.find((f) => f.slot === 2)!;
    expect(withFill.valid[0]).toBe(true);
    expect(withFill.labs[0]).toEqual(ARUCO_REFS[want]);
    expect(withFill.weight[0]).toBe(COLOR_CONF);
    expect(withFill.ids?.[0] ?? -1).toBe(-1);
  });
});

// 実写（実物のキューブの写真）での認識とスキャンの組み立て。
// 合成画像はステッカーの角が尖っていて色も素直なので、実物の難しさ（丸い角・艶・カメラの色合い）はここで確かめる。
// 写真は tests/fixtures/real/README.md を参照（黄色がクリーム色、オレンジがサーモンピンクに写っている）。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { inflateSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { F } from "../src/cube/model";
import { assignBalanced } from "../src/scan/assign";
import { type ScannedFace, assembleScan } from "../src/scan/scan";
import { DEFAULT_PIPELINE, processFrame } from "../src/vision/pipeline";
import { type CV, initOpenCv } from "../src/vision/quads";

const DIR = new URL("./fixtures/real/", import.meta.url);
const SIDES = ["U", "R", "F", "D", "L", "B"];
// 正解ファイルの面の並び（このリポジトリの道具は ULFRBD 順）
const TRUTH_ORDER = ["U", "L", "F", "R", "B", "D"];

let cv: CV;
beforeAll(async () => {
  cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
}, 120000);

function load(side: string) {
  const truth = JSON.parse(readFileSync(new URL("dw-truth.json", DIR), "utf8")) as { size: [number, number]; rgb: number[][] };
  const [w, h] = truth.size;
  const rgb = inflateSync(readFileSync(new URL(`dw-${side}.rgb.z`, DIR)));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgb[i * 3];
    data[i * 4 + 1] = rgb[i * 3 + 1];
    data[i * 4 + 2] = rgb[i * 3 + 2];
    data[i * 4 + 3] = 255;
  }
  return { img: { data, width: w, height: h }, truth };
}

// 正解の RGB を 6 色（各 9 枚）に分ける（センターを種に）
function truthLabels(rgb: number[][]): number[] {
  const centers = [4, 13, 22, 31, 40, 49].map((i) => rgb[i]);
  return assignBalanced(rgb.map((c) => centers.map((k) => Math.hypot(c[0] - k[0], c[1] - k[1], c[2] - k[2]))));
}

describe("real photos (robot-held cube, washed-out colors)", () => {
  it("finds the full face in every photo", () => {
    for (const side of SIDES) {
      const { img } = load(side);
      const r = processFrame(cv, img, 0, DEFAULT_PIPELINE, { last: null }, null, []);
      const front = r.faces.find((f) => f.slot === F);
      expect(front, side).toBeDefined();
      expect(front!.valid.filter(Boolean).length, side).toBe(9);
    }
  });

  it("assembles a valid cube whose faces match the ground truth", () => {
    const scanned: ScannedFace[] = [];
    let truth: number[][] = [];
    SIDES.forEach((side, i) => {
      const { img, truth: t } = load(side);
      truth = t.rgb;
      const r = processFrame(cv, img, 0, DEFAULT_PIPELINE, { last: null }, null, []);
      scanned.push({ face: i, labs: r.faces.find((f) => f.slot === F)!.labs });
    });
    const result = assembleScan(scanned, "standard");
    // 面ごとの色の組（向きは問わない）が正解と一致すること（色の番号はどちらも「写真 k のセンターの色」）
    const tl = truthLabels(truth);
    // 正解の色の番号（正解ファイルの面 k のセンターの色）→ 写真の番号
    const toPhoto = TRUTH_ORDER.map((side) => SIDES.indexOf(side));
    for (let i = 0; i < 6; i++) {
      const t = TRUTH_ORDER.indexOf(SIDES[i]);
      const ours = [...result.cellLabels.slice(i * 9, i * 9 + 9)].sort();
      const want = tl.slice(t * 9, t * 9 + 9).map((c) => toPhoto[c]).sort();
      expect(ours, SIDES[i]).toEqual(want);
    }
    expect(result.problems).toEqual([]);
  });
});

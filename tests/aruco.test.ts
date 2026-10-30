// 色付き ArUco ステッカーの検出と集計（フェーズ0追加検証のテストモード、src/aruco）。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ArucoBench, DEFAULT_CONFIGS, type Marker } from "../src/aruco/detect";
import { demuxFile, readSamples, rotationOf } from "../src/aruco/demux";
import { ARUCO12_CODES, CONFUSABLE12, UNIQUE54_CODES, byteList, centerOffset, distance3, code4x4, decode, makeDictionary, markerBits as schemeBits } from "../src/aruco/codes";
import { colorConsistent, frameColorFilter } from "../src/aruco/cube";
import { DESIGNS, SHADE, STANDARD_DESIGN, designLook } from "../src/aruco/design";
import { moveAt, moveSpans, playerTimestamp } from "../src/aruco/timeline";
import { markerBits } from "../src/aruco/dict4x4";
import { PRINT_COLORS } from "../src/aruco/palette";
import { type FrameRecord, summarize, toCsv, toMarkdown } from "../src/aruco/stats";
import { SHEETS, classifyColor, stickerOf } from "../src/aruco/stickers";
import { type CV, initOpenCv } from "../src/vision/quads";
import { type RenderMarker, renderStickers } from "./arucoRender";

let cv: CV;
beforeAll(async () => {
  cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
}, 120000);

const RGB = {
  white: [228, 228, 222],
  red: [190, 25, 35],
  green: [25, 150, 70],
  yellow: [235, 205, 30],
  orange: [240, 115, 25],
  blue: [20, 65, 170],
} as const;

const TEST = SHEETS.find((s) => s.key === "test")!;

// テストページ: ID 90〜92（白・赤・青）× 12/15/18mm を 3 列に並べる。
// 背景は黒（キューブの本体と同じ）。白い紙の上だと、赤・青は色の余白ごと 1 つの枠として検出される（辺が 1/0.84 倍）
function testPage(pxPerMm: number, ox = 0, oy = 0): RenderMarker[] {
  const colors = [RGB.white, RGB.red, RGB.blue];
  const out: RenderMarker[] = [];
  [12, 15, 18].forEach((mm, row) => {
    [90, 91, 92].forEach((id, col) => {
      out.push({ id, rgb: [...colors[col]] as [number, number, number], cx: 160 + col * 130 + ox, cy: 90 + row * 120 + oy, size: mm * pxPerMm });
    });
  });
  return out;
}

describe("ステッカーの仕様", () => {
  it("OpenCV なしで描くマーカーの表が DICT_4X4_100 と一致する", () => {
    const d = cv.getPredefinedDictionary(cv.DICT_4X4_100);
    for (let id = 0; id < 100; id++) {
      const m = new cv.Mat();
      cv.generateImageMarker(d, id, 6, m, 1);
      expect(Array.from(markerBits(id))).toEqual(Array.from(m.data as Uint8Array).map((v) => (v > 127 ? 1 : 0)));
      m.delete();
    }
    d.delete();
  });

  it("ID = facelet 番号、ID÷9 が色", () => {
    expect(stickerOf(0)).toEqual({ face: 0, pos: 0, color: "white" });
    expect(stickerOf(22)).toEqual({ face: 2, pos: 4, color: "green" });
    expect(stickerOf(53)).toEqual({ face: 5, pos: 8, color: "blue" });
    expect(stickerOf(90)).toBeNull();
  });

  it("写った色を 6 色に分ける", () => {
    for (const [name, rgb] of Object.entries(RGB)) expect(classifyColor([...rgb] as [number, number, number])).toBe(name);
  });
});

describe("検出", () => {
  it("6 色すべて、ID と向きが読める（グレー・max とも）", () => {
    const markers: RenderMarker[] = Object.values(RGB).map((rgb, face) => ({
      id: face * 9 + 4,
      rgb: [...rgb] as [number, number, number],
      cx: 110 + face * 140,
      cy: 200,
      size: 80,
      angle: face * 30 - 60,
    }));
    const img = renderStickers(cv, markers, { width: 960, height: 400, background: [30, 30, 32], noise: 3 });
    const bench = new ArucoBench(cv, DEFAULT_CONFIGS.slice(0, 2));
    const res = bench.detect(img);
    bench.delete();
    for (const r of res) {
      expect(r.markers.map((m) => m.id).sort((a, b) => a - b)).toEqual([4, 13, 22, 31, 40, 49]);
      for (const m of r.markers) {
        const face = Math.floor(m.id / 9);
        const want = face * 30 - 60;
        expect(Math.abs(((m.angle - want + 540) % 360) - 180)).toBeLessThan(3);
        expect(m.side).toBeGreaterThan(80 * 0.84 - 3);
        expect(m.side).toBeLessThan(80 * 0.84 + 3);
        expect(classifyColor(m.rgb)).toBe(stickerOf(m.id)!.color);
      }
    }
  });

  it("max(RGB) は暗い青・赤のセルのコントラストを保つ", () => {
    const markers: RenderMarker[] = [
      { id: 49, rgb: [...RGB.blue] as [number, number, number], cx: 100, cy: 100, size: 90 },
      { id: 13, rgb: [...RGB.red] as [number, number, number], cx: 240, cy: 100, size: 90 },
    ];
    const img = renderStickers(cv, markers, { width: 340, height: 200, background: [30, 30, 32] });
    const bench = new ArucoBench(cv, DEFAULT_CONFIGS.slice(0, 1));
    const [r] = bench.detect(img);
    bench.delete();
    for (const m of r.markers) expect(m.contrastMax).toBeGreaterThan(m.contrastGray * 1.8);
  });
});

describe("テストページの集計", () => {
  it("同じ ID の 3 つの大きさを区別し、色ごと・大きさごとの検出率を出す", () => {
    const configs = DEFAULT_CONFIGS.slice(0, 2);
    const bench = new ArucoBench(cv, configs);
    const frames: FrameRecord[] = [];
    for (let i = 0; i < 6; i++) {
      const img = renderStickers(cv, testPage(3.2, i * 2, i), { width: 560, height: 400, background: [30, 30, 32], noise: 2, seed: i + 1 });
      frames.push({ t: (i * 1000) / 240, results: bench.detect(img) });
    }
    bench.delete();
    const sum = summarize({ frames, configs: configs.map((c) => c.name), sheet: TEST, width: 560, height: 400, timeScale: 1 });
    expect(sum.fps).toBeCloseTo(240, 0);
    expect(sum.slots).toHaveLength(2 * 9);
    for (const s of sum.slots) {
      expect(s.rateRange).toBe(1);
      expect(s.inRange).toBe(6);
      // 大きさの割り当てが正しい: 1 セルの画素数 ≈ 大きさ × 3.2 × 0.84 / 6
      expect(s.pxPerCell).toBeCloseTo((s.size * 3.2 * 0.84) / 6, 0);
    }
    // ID と色の対応を決めつけず、写った色で分ける
    const colorOf = (id: number) => sum.slots.find((s) => s.id === id)!.color;
    expect([colorOf(90), colorOf(91), colorOf(92)]).toEqual(["white", "red", "blue"]);
    expect(sum.groups.filter((g) => g.config === 0)).toHaveLength(9);
    const md = toMarkdown(sum, TEST, { 動画: "synthetic" });
    expect(md).toContain("| 白 |");
    const csv = toCsv(sum);
    expect(csv.split("\n").filter(Boolean)).toHaveLength(1 + 18);
  });
});

describe("集計（検出結果から）", () => {
  const marker = (id: number, cx: number, cy: number, side: number): Marker => ({
    id,
    corners: [cx - side / 2, cy - side / 2, cx + side / 2, cy - side / 2, cx + side / 2, cy + side / 2, cx - side / 2, cy + side / 2],
    side,
    angle: 0,
    rgb: [200, 200, 200],
    contrastGray: 100,
    contrastMax: 120,
    fit: 1,
  });
  const frame = (i: number, markers: Marker[]): FrameRecord => ({ t: i * 4, results: [{ markers, ms: 10 }] });

  it("途切れ・大きさの割り当て・速さ・誤検出", () => {
    const sheet = { key: "t", label: "t", ids: [90], sizes: [12, 18], scheme: "aruco54" as const };
    const frames: FrameRecord[] = [];
    for (let i = 0; i < 20; i++) {
      const ms: Marker[] = [];
      // 18mm（辺 54px）は x=100 で止まっている。6〜9 フレーム目は読めない
      if (i < 6 || i > 9) ms.push(marker(90, 100, 100, 54));
      // 12mm（辺 36px）は 1 フレームに 30px 右へ動く
      ms.push(marker(90, 100 + i * 30, 200, 36));
      if (i === 3) ms.push(marker(7, 300, 300, 40)); // シートにない ID
      frames.push(frame(i, ms));
    }
    const sum = summarize({ frames, configs: ["a"], sheet, width: 800, height: 400, timeScale: 1 });
    const big = sum.slots.find((s) => s.size === 18)!;
    const small = sum.slots.find((s) => s.size === 12)!;
    expect(big.hits).toBe(16);
    expect(big.inRange).toBe(20);
    expect(big.longestGap).toBe(4);
    expect(big.longestGapMs).toBe(20); // 5 フレーム目 → 10 フレーム目
    expect(big.pxPerCell).toBe(9);
    expect(small.pxPerCell).toBe(6);
    expect(small.rateRange).toBe(1);
    expect(sum.configs[0].unexpected).toBe(1);
    // 止まっている 18mm は最も遅い区分、動く 12mm（30px/4ms）は速い区分
    expect(big.speed[0].n).toBe(20);
    expect(small.speed[4].n).toBe(20); // 30px / 6px / 4ms = 1250 マス/秒
  });

  it("撮影 fps を指定すると実時間に直す（スロー再生で書き出された動画）", () => {
    const sheet = { key: "t", label: "t", ids: [1], sizes: [18], scheme: "aruco54" as const };
    // 30fps の動画に見えるが、実際は 240fps（8 倍のスロー）
    const frames = Array.from({ length: 10 }, (_, i) => ({ t: (i * 1000) / 30, results: [{ markers: i === 4 ? [] : [marker(1, 50, 50, 30)], ms: 5 }] }));
    const sum = summarize({ frames, configs: ["a"], sheet, width: 200, height: 200, timeScale: 30 / 240 });
    expect(sum.fps).toBeCloseTo(240, 3);
    expect(sum.slots[0].longestGapMs).toBeCloseTo((2 * 1000) / 240, 3);
  });
});

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("動画の分解", () => {
  it("表示行列から時計回りの回転", () => {
    expect(rotationOf([65536, 0, 0, 0, 65536, 0, 0, 0, 1 << 30])).toBe(0);
    expect(rotationOf([0, 65536, 0, -65536, 0, 0, 0, 0, 1 << 30])).toBe(90);
    expect(rotationOf([-65536, 0, 0, 0, -65536, 0, 0, 0, 1 << 30])).toBe(180);
    expect(rotationOf([0, -65536, 0, 65536, 0, 0, 0, 0, 1 << 30])).toBe(270);
  });

  // ffmpeg で 240fps の動画を作り、全フレームのサンプル表と回転を読めること（moov が後ろにある普通の MP4 / MOV）
  it.skipIf(!hasFfmpeg)("240fps の MP4・回転つきの MOV", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aruco-"));
    const mp4 = join(dir, "a.mp4");
    const mov = join(dir, "b.mov");
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=240", "-t", "0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", mp4]);
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-display_rotation", "90", "-i", mp4, "-c", "copy", mov]);
    for (const [file, rot] of [
      [mp4, 0],
      [mov, 270], // ffmpeg の display_rotation は反時計回り
    ] as const) {
      const blob = new Blob([readFileSync(file)]);
      const d = await demuxFile(blob);
      expect(d.codec).toMatch(/^avc1/);
      expect([d.width, d.height]).toEqual([320, 180]);
      expect(d.rotation).toBe(rot);
      expect(d.samples).toHaveLength(120);
      expect(d.fps).toBeCloseTo(240, 3);
      expect(d.samples[0].key).toBe(true);
      expect(d.config.description).toBeDefined();
      let n = 0;
      for await (const s of readSamples(blob, d.samples)) {
        expect(s.data.length).toBe(d.samples[s.index].size);
        n++;
      }
      expect(n).toBe(120);
    }
  });
});

// 12 種類（3×3）の符号（src/aruco/codes.ts）
describe("12 種類（3×3）の符号", () => {
  const pop = (x: number) => {
    let k = 0;
    while (x) (x &= x - 1), k++;
    return k;
  };
  const rot = (c: number) => {
    let out = 0;
    for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) if ((c >> (r * 3 + q)) & 1) out |= 1 << (q * 3 + (2 - r));
    return out;
  };
  const rots = (c: number) => [c, rot(c), rot(rot(c)), rot(rot(rot(c)))];
  const dist = (a: number, b: number) => Math.min(...rots(b).map((x) => pop(a ^ x)));

  it("距離 2 以上・同じ色のセンターとそれ以外は 3 以上・距離 2 の組は見分けやすい色どうし", () => {
    const close = new Set(["0,3", "3,0", "1,4", "4,1", "3,4", "4,3"]); // 白と黄・赤と橙・黄と橙
    ARUCO12_CODES.forEach((c, i) => {
      expect(Math.min(...rots(c).slice(1).map((x) => pop(c ^ x)))).toBeGreaterThanOrEqual(2); // 向きが決まる
      for (let j = i + 1; j < 12; j++) {
        const d = dist(c, ARUCO12_CODES[j]);
        expect(d).toBeGreaterThanOrEqual(2);
        if (i % 6 === j % 6) expect(d).toBeGreaterThanOrEqual(3);
        if (d === 2) expect(close.has(`${i % 6},${j % 6}`)).toBe(false);
      }
    });
  });

  it("バイト列の組み立てが OpenCV と同じ（DICT_4X4_100 で照合）・作った辞書で描くと同じビット", () => {
    const d = cv.getPredefinedDictionary(cv.DICT_4X4_100);
    const ref = d.bytesList.data as Uint8Array;
    for (let id = 0; id < 100; id++) {
      const mine = byteList(code4x4(id), 4);
      expect(Array.from(mine)).toEqual(Array.from(ref.subarray(id * mine.length, (id + 1) * mine.length)));
    }
    d.delete();
    const d12 = makeDictionary(cv, "aruco12");
    for (let id = 0; id < 12; id++) {
      const m = new cv.Mat();
      cv.generateImageMarker(d12, id, 5, m, 1);
      expect(Array.from(m.data as Uint8Array).map((v) => (v > 127 ? 1 : 0))).toEqual(Array.from(schemeBits("aruco12", id)));
      m.delete();
    }
    d12.delete();
  });

  it("ID → 色・センター", () => {
    expect(decode("aruco12", 0)).toEqual({ face: 0, center: false, sticker: -1 });
    expect(decode("aruco12", 11)).toEqual({ face: 5, center: true, sticker: -1 });
    expect(decode("aruco12", 12)).toBeNull();
    expect(decode("aruco54", 22)).toEqual({ face: 2, center: true, sticker: 22 });
  });

  it("色の照合: 自分の色は通し、2 ビットで入れ替わりうる ID の色に見えたら捨てる・照明で色がずれても捨てない", () => {
    const rgbOf = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
    expect(CONFUSABLE12.map((js, i) => js.map((j) => `${i}-${j}`)).flat().sort()).toEqual(["0-1", "1-0", "10-2", "2-10", "2-6", "6-2", "7-9", "9-7"]);
    for (let id = 0; id < 12; id++) {
      expect(colorConsistent("aruco12", id, rgbOf(PRINT_COLORS[id % 6]))).toBe(true);
      for (const j of CONFUSABLE12[id]) expect(colorConsistent("aruco12", id, rgbOf(PRINT_COLORS[j % 6]))).toBe(false);
    }
    // 実物の動画（暖かい照明）で写った色: 薄い青は灰色、薄い緑は黄緑に写った
    expect(colorConsistent("aruco12", 5, [93, 99, 109])).toBe(true);
    expect(colorConsistent("aruco12", 2, [76, 79, 53])).toBe(true);
    // 54 種類は写った色が ID の色に近いこと
    expect(colorConsistent("aruco54", 45, rgbOf(PRINT_COLORS[5]))).toBe(true);
    expect(colorConsistent("aruco54", 45, [93, 99, 109])).toBe(false);
  });

  it("マスごとに違う 54 種類: 回転を含めて全部違い・向きが決まり・OpenCV の辞書と同じビット・真ん中の向き", () => {
    expect(UNIQUE54_CODES.length).toBe(54);
    UNIQUE54_CODES.forEach((c, i) => {
      for (let j = i + 1; j < 54; j++) expect(distance3(c, UNIQUE54_CODES[j])).toBeGreaterThanOrEqual(2);
      expect(Math.min(...rots(c).slice(1).map((x) => pop(c ^ x)))).toBeGreaterThanOrEqual(2);
    });
    const d = makeDictionary(cv, "unique54");
    for (let id = 0; id < 54; id++) {
      const m = new cv.Mat();
      cv.generateImageMarker(d, id, 5, m, 1);
      expect(Array.from(m.data as Uint8Array).map((v) => (v > 127 ? 1 : 0))).toEqual(Array.from(schemeBits("unique54", id)));
      m.delete();
    }
    d.delete();
    expect(decode("unique54", 22)).toEqual({ face: 2, center: true, sticker: 22 });
    expect(centerOffset(0)).toEqual([1, 1]); // 左上の角: 真ん中は右下
    expect(centerOffset(5)).toEqual([-1, 0]); // 右の辺: 真ん中は左
    expect(centerOffset(4)).toEqual([0, 0]);
  });

  it("写った色をフレームの中で比べる: 照明で全体の色がずれても捨てず、仲間と違う色の誤読は捨てる", () => {
    // 暖かい照明: 白は黄みがかり、青は灰色っぽく写る（実物の動画の値）
    const warm: Record<number, [number, number, number]> = { 0: [176, 158, 129], 5: [93, 99, 109], 1: [200, 90, 80] };
    const ms = [0, 0, 0, 5, 5, 5, 1, 1].map((face) => ({ face, rgb: warm[face] }));
    expect(frameColorFilter(ms).length).toBe(8);
    // 白に写ったのに青と読んだもの（青の仲間から遠く、白の仲間に近い）は捨てる
    const wrong = { face: 5, rgb: [178, 160, 130] as [number, number, number] };
    expect(frameColorFilter([...ms, wrong]).includes(wrong)).toBe(false);
  });

  it("印刷用 PDF のスクリプトと符号・色が同じ", async () => {
    // @ts-expect-error 型のない .mjs
    const sheet = await import("../scripts/aruco-stickers.mjs");
    expect(sheet.CODES).toEqual(ARUCO12_CODES);
    expect(sheet.CODES_U54).toEqual(UNIQUE54_CODES);
    expect(sheet.COLORS).toEqual(PRINT_COLORS);
    expect(sheet.DESIGNS).toEqual(DESIGNS);
    expect(sheet.SHADE).toBe(SHADE);
  });

  it("マーカーの配置: 今のステッカーは色の縁 8% の内側いっぱいで、小さくするほど印刷色の面積が増える", () => {
    expect(STANDARD_DESIGN.side).toBeCloseTo(1 - 2 * 0.08);
    // マーカーはステッカーからはみ出さず、4 個のものは重ならない
    for (const d of DESIGNS) {
      for (const [x, y] of d.at) {
        expect(x - d.side / 2).toBeGreaterThan(0.03);
        expect(x + d.side / 2).toBeLessThan(0.97);
        expect(y - d.side / 2).toBeGreaterThan(0.03);
      }
      if (d.at.length === 4) expect(d.at[1][0] - d.at[0][0]).toBeGreaterThan(d.side + 0.05);
    }
    const area = (k: string) => designLook(DESIGNS.find((d) => d.key === k)!).colorArea;
    expect(area("standard")).toBeCloseTo(0.42, 1);
    expect(area("half")).toBeGreaterThan(0.8);
    expect(area("third")).toBeGreaterThan(area("half"));
    expect(area("quad-half")).toBeLessThan(area("half"));
    // 濃い同色は印刷色の面積は同じで、離れて見た色が印刷色に近い
    expect(designLook(DESIGNS.find((d) => d.key === "standard-shade")!).meanDeltaE).toBeLessThan(designLook(STANDARD_DESIGN).meanDeltaE);
  });
});

// 動画解析の 3D を実際の速さと間で動かす（src/aruco/timeline.ts）
describe("3D の再生の時間", () => {
  const mv = (t0: number | undefined, t: number) => ({ move: 0, t0, t, orient: 0 });
  it("回している間は比例で進み、手の間は前の手の終わりで止まる", () => {
    const moves = [mv(1000, 1100), mv(1500, 1700)];
    const spans = moveSpans(moves);
    const pStart = [0, 1000];
    const pDur = [1000, 1500];
    expect(playerTimestamp(500, spans, pStart, pDur)).toBe(0);
    expect(playerTimestamp(1050, spans, pStart, pDur)).toBe(500);
    expect(playerTimestamp(1300, spans, pStart, pDur)).toBe(1000); // 間: 1 手目の終わり
    expect(playerTimestamp(1600, spans, pStart, pDur)).toBe(1750);
    expect(playerTimestamp(9999, spans, pStart, pDur)).toBe(2500);
    expect(moveAt(1300, spans)).toBe(0);
    expect(moveAt(900, spans)).toBe(-1);
  });
  it("回し始めの分からない手・重なる手は、前の手の後ろにずらす", () => {
    const spans = moveSpans([mv(1000, 1200), mv(1100, 1150), mv(undefined, 1400)]);
    expect(spans[1].start).toBe(1200);
    expect(spans[1].end).toBeGreaterThan(spans[1].start);
    expect(spans[2]).toEqual({ start: 1280, end: 1400 });
  });
});

// 実物の ArUco ステッカー（12 種類）を写した映像で、検出・色の照合・面の組み立てのどこで落ちるかを調べる。
//   ffmpeg -i rec.mov -vf "crop=…,fps=20" -f rawvideo -pix_fmt rgba frames.rgba
//   ARUCO_RAW=frames.rgba ARUCO_W=700 ARUCO_H=1248 npx vitest run -c vitest.debug.config.ts tests/debug/realAruco.debug.test.ts
import { openSync, readSync } from "node:fs";
import { createRequire } from "node:module";
import { it } from "vitest";
import { decode } from "../../src/aruco/codes";
import { colorConsistent, reconstructFaces } from "../../src/aruco/cube";
import { ArucoBench, DEFAULT_CONFIGS } from "../../src/aruco/detect";
import { FACE_NAMES, classifyColor } from "../../src/aruco/stickers";
import { initOpenCv } from "../../src/vision/image";

it("実物の映像", async () => {
  const file = process.env.ARUCO_RAW;
  if (!file) return;
  const W = Number(process.env.ARUCO_W);
  const H = Number(process.env.ARUCO_H);
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const configs = process.env.ARUCO_ALL ? DEFAULT_CONFIGS : process.env.PARAMS ? [{ name: "指定", preprocess: "max" as const, params: JSON.parse(process.env.PARAMS) }] : [DEFAULT_CONFIGS[1]];
  const bench = new ArucoBench(cv, configs, "aruco12");
  const fd = openSync(file, "r");
  const buf = new Uint8ClampedArray(W * H * 4);
  const perFace = FACE_NAMES.map(() => ({ seen: 0, rejected: 0, as: {} as Record<string, number>, rgb: [0, 0, 0] }));
  let frames = 0;
  let withFront = 0;
  let prevTilt: number[] | null = null;
  const lines: string[] = [];
  for (let i = 0; ; i++) {
    if (readSync(fd, buf, 0, buf.length, i * buf.length) < buf.length) break;
    frames++;
    const res = bench.detect({ data: buf, width: W, height: H });
    const markers = res[0].markers;
    for (const m of markers) {
      const d = decode("aruco12", m.id)!;
      const pf = perFace[d.face];
      pf.seen++;
      if (!colorConsistent("aruco12", m.id, m.rgb)) {
        pf.rejected++;
        const c = classifyColor(m.rgb);
        pf.as[c] = (pf.as[c] ?? 0) + 1;
        for (let k = 0; k < 3; k++) pf.rgb[k] += m.rgb[k];
      }
    }
    const r = reconstructFaces(markers, { width: W, height: H }, prevTilt, "aruco12");
    if (r.faces.length) prevTilt = r.tilt;
    const front = r.faces.some((f) => f.slot === 2);
    if (front) withFront++;
    const others = res.slice(1).map((x) => x.markers.length);
    lines.push(`${(i / 20).toFixed(2)}s 検出 ${markers.length}${others.length ? `（他の方式 ${others.join("/")}）` : ""} 面 ${r.faces.map((f) => `${f.slot}:${f.colors.filter((c) => c >= 0).length}`).join(",") || "-"}${front ? "" : " 正面なし"}`);
  }
  console.log(lines.join("\n"));
  console.log(`R フレーム ${frames}・正面が組み立てられた ${withFront}（${((100 * withFront) / frames).toFixed(0)}%）`);
  perFace.forEach((p, f) => {
    const rej = p.rejected ? `・平均の色 ${p.rgb.map((v) => Math.round(v / p.rejected)).join(",")} → ${JSON.stringify(p.as)}` : "";
    console.log(`R ${FACE_NAMES[f]}: 検出 ${p.seen}・色で捨てた ${p.rejected}${rej}`);
  });
  bench.delete();
});

// ライブの経路（processFrame → 追跡エンジン → 姿勢）で、3D の向き（キューブ固定 → カメラ = R · ORIENTATIONS[o]）が
// 途切れる長さと、隣の姿勢から大きく飛ぶ回数を数える（Cube3D の持ち替えの判定と同じく、o が 2 フレーム続くまで待つ）
it("ライブの経路での 3D の向き", async () => {
  const file = process.env.ARUCO_RAW;
  if (!file) return;
  const W = Number(process.env.ARUCO_W);
  const H = Number(process.env.ARUCO_H);
  const FPS = Number(process.env.ARUCO_FPS ?? 20);
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const { DEFAULT_PIPELINE, processFrame } = await import("../../src/vision/pipeline");
  const { TrackerEngine } = await import("../../src/track/engine");
  const { estimatePose, rotationAngle } = await import("../../src/vision/pose");
  const { ORIENTATIONS, mul, solvedState } = await import("../../src/cube/model");
  const { ARUCO_REFS } = await import("../../src/aruco/palette");
  const engine = new TrackerEngine(solvedState(), ARUCO_REFS);
  const pipeline = { ...DEFAULT_PIPELINE, stickers: "aruco12" as const };
  const memory = { last: null };
  const fd = openSync(file, "r");
  const buf = new Uint8ClampedArray(W * H * 4);
  const angle = (a: number[], b: number[]) => {
    let tr = 0;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) tr += a[r * 3 + c] * b[r * 3 + c];
    return (Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180) / Math.PI;
  };
  let posed = 0;
  let frames = 0;
  let gap = 0;
  let maxGap = 0;
  let jumps = 0;
  let prev: number[] | null = null;
  // 画面の録画では、アプリが認識できたフレームに重ね描き（水色の枠）が写ってマーカーを隠す。重ね描きのないフレーム
  // （アプリが認識できなかったフレーム）だけを別に数える
  let bare = 0;
  let barePosed = 0;
  let cur = -1;
  let pending = -1;
  let count = 0;
  const log: string[] = [];
  for (let i = 0; ; i++) {
    if (readSync(fd, buf, 0, buf.length, i * buf.length) < buf.length) break;
    frames++;
    const t = (i * 1000) / FPS;
    const r = processFrame(cv, { data: buf, width: W, height: H }, t, pipeline, memory);
    const reading = { t, faces: r.faces.map((f) => ({ slot: f.slot, labs: f.labs, valid: f.valid, weight: f.weight, spread: f.spread, masked: f.masked, ids: f.ids })) };
    engine.push(reading);
    let M: number[] | null = null;
    if (reading.faces.length) {
      const p = estimatePose(r.faces, W, H);
      if (p && p.err < Math.max(4, W / 100)) {
        const R = p.R as number[];
        const base = prev;
        let o = engine.frameOrient(reading, engine.labelsOf(reading), base && !process.env.NO_CONT ? (k) => (0.9 * rotationAngle([...mul(R as never, ORIENTATIONS[k])], base)) / Math.PI : undefined);
        let hold = false;
        if (cur >= 0 && o !== cur) {
          count = o === pending ? count + 1 : 1;
          pending = o;
          if (count < 2) {
            hold = true;
            o = cur;
          }
        }
        if (!(hold && !process.env.OLD_HOLD)) {
          cur = o;
          M = mul(p.R as never, ORIENTATIONS[o]) as unknown as number[];
        }
      }
    }
    let cyan = 0;
    for (let k = 0; k < buf.length; k += 16) if (buf[k] < 140 && buf[k + 1] > 170 && buf[k + 2] > 225) cyan++;
    const overlay = cyan > 150;
    if (!overlay) bare++;
    if (M && !overlay) barePosed++;
    if (process.env.DIAG && t >= 3900 && t <= 4700)
      log.push(`\n  ${(t / 1000).toFixed(2)} o=${cur} faces ${r.faces.map((f) => `${f.slot}:${f.labs.map((l, k) => (f.valid[k] ? "WRGYOB"[ARUCO_REFS.findIndex((x) => x[0] === l[0] && x[1] === l[1])] : ".")).join("")}`).join(" ")}${M ? "" : " 姿勢なし"}`);
    if (M) {
      posed++;
      maxGap = Math.max(maxGap, gap);
      if (prev) {
        const a = angle(prev, M);
        if (a > 30) {
          jumps++;
          log.push(`${(t / 1000).toFixed(2)}s ${a.toFixed(0)}°（${gap} フレーム空き）`);
        }
      }
      prev = M;
      gap = 0;
    } else gap++;
  }
  console.log(`R 重ね描きのない（アプリが認識できなかった）フレーム ${bare} のうち姿勢あり ${barePosed}（${((100 * barePosed) / Math.max(1, bare)).toFixed(0)}%）`);
  console.log(`R 姿勢あり ${posed} / ${frames}（${((100 * posed) / frames).toFixed(0)}%）・最長の途切れ ${maxGap} フレーム・30° 以上の飛び ${jumps}: ${log.join("、")}`);
});

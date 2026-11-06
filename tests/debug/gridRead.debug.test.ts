// 格子で読む（src/aruco/gridRead.ts）の精度と速さ: 検出で ID が読めたマスを格子で読み直して同じ ID になるか・読めなかったマスで
// 新しく読めた数。seqBench が描いた画像（CACHE=）を使う
//   CACHE=… SEEDS=1-5 npx vitest run -c vitest.debug.config.ts tests/debug/gridRead.debug.test.ts --silent=false
import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { it } from "vitest";
import { cellH } from "../../src/aruco/cube";
import { designOf } from "../../src/aruco/design";
import { gridReadCell } from "../../src/aruco/gridRead";
import { processFrame } from "../../src/vision/pipeline";
import { loadTestOpenCv } from "../cv";

const VIEWS = [
  { name: "near", w: 1280, h: 960 },
  { name: "far", w: 1280, h: 960 },
  { name: "tall", w: 720, h: 1280 },
  { name: "oblique", w: 1280, h: 720 },
  { name: "low", w: 1280, h: 720 },
];

it("格子で読む", async () => {
  const cv = await loadTestOpenCv();
  const dir = process.env.CACHE!;
  const [from, to] = (process.env.SEEDS ?? "1-5").split("-").map(Number);
  const speed = process.env.SPEED ?? "normal";
  const design = designOf("quad-half");
  let agree = 0;
  let bad = 0;
  let miss = 0;
  let fresh = 0;
  let unknown = 0;
  let ms = 0;
  const scaleFix = new Map<number, number>();
  let calls = 0;
  for (let seed = from; seed <= to; seed++) {
    const view = VIEWS[seed % 5];
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(`${speed}-30-${seed}-`))
      .map((f) => ({ f, t: Number(f.split("-")[3].replace(".gz", "")) }))
      .sort((a, b) => a.t - b.t);
    const memory = {};
    for (let i = 0; i < files.length; i += Number(process.env.STEP ?? 2)) {
      const img = { data: new Uint8ClampedArray(gunzipSync(readFileSync(`${dir}/${files[i].f}`))), width: view.w, height: view.h };
      const res = processFrame(cv as never, img, files[i].t, { stickers: "unique54", arucoDesign: "quad-half", arucoThorough: true, arucoRegion: true, arucoReread: 0, arucoColorFill: false, arucoIdTrack: false }, memory);
      for (const f of res.faces) {
        if (f.held || !f.marker) continue;
        const S = f.marker / 0.84;
        for (let cell = 0; cell < 9; cell++) {
          const t0 = performance.now();
          const g = gridReadCell(img, cellH(f, cell), cell, "unique54", design, S);
          ms += performance.now() - t0;
          calls++;
          const known = f.ids?.[cell] ?? -1;
          if (known >= 0) {
            if (!g) {
              miss++;
              for (const k of [0.85, 0.92, 1.08, 1.15]) if (gridReadCell(img, cellH(f, cell), cell, "unique54", design, S * k)?.id === known) scaleFix.set(k, (scaleFix.get(k) ?? 0) + 1);
            }
            else if (g.id === known) agree++;
            else {
              bad++;
              if (process.env.VERBOSE) process.stdout.write(`# bad seed ${seed} t ${files[i].t} slot ${f.slot} cell ${cell} known ${known} got ${g.id} fit ${g.fit.toFixed(2)}\n`);
            }
          } else {
            unknown++;
            if (g) fresh++;
          }
        }
      }
    }
    process.stdout.write(`# seed ${seed}: 同じ ${agree} 違う ${bad} 読めない ${miss} | 検出で読めなかった ${unknown} のうち読めた ${fresh} | ${(ms / calls).toFixed(3)}ms/マス | 大きさを変えると読めた ${JSON.stringify([...scaleFix])}\n`);
  }
}, 7200000);

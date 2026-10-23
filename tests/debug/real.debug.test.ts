// 実写（実機の写真・手持ち動画のフレーム）に認識をかけて、検出した面と各セルの色を画像に描いて出す。
//   REAL_DIR=/path/to/frames（meta.json と <name>.rgba） REAL_OUT=/path/to/out npx vitest run -c vitest.debug.config.ts tests/debug/real.debug.test.ts
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { it } from "vitest";
import { NAMED_COLORS, nearestNamed } from "../../src/vision/color";
import { slotPoint } from "../../src/vision/layout";
import { DEFAULT_PIPELINE, processFrame } from "../../src/vision/pipeline";
import { initOpenCv } from "../../src/vision/quads";
import { drawLine, writePng } from "./png";

const DIR = process.env.REAL_DIR ?? "/home/user/realdata/frames";
const OUT = process.env.REAL_OUT ?? "/tmp/real-out";
const ONLY = process.env.REAL_ONLY;

const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

it("real frames", async () => {
  if (!existsSync(`${DIR}/meta.json`)) return;
  const cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  const meta = JSON.parse(readFileSync(`${DIR}/meta.json`, "utf8")) as Record<string, [number, number]>;
  const summary: string[] = [];
  for (const [name, [w, h]] of Object.entries(meta)) {
    if (ONLY && !name.startsWith(ONLY)) continue;
    const data = new Uint8ClampedArray(readFileSync(`${DIR}/${name}.rgba`));
    const img = { data, width: w, height: h };
    const memory = { last: null };
    (globalThis as { __cvDebug?: (m: unknown) => void }).__cvDebug = process.env.REAL_DEBUG ? (m) => process.stdout.write(`plausible ${JSON.stringify(m)}\n`) : undefined;
    const r = processFrame(cv, img, 0, DEFAULT_PIPELINE, memory, null, []);
    const out = { data: new Uint8ClampedArray(data), width: w, height: h };
    for (const q of r.quads) for (let i = 0; i < 4; i++) drawLine(out, q[i] as [number, number], q[(i + 1) % 4] as [number, number], [255, 0, 255]);
    const faceStr: string[] = [];
    for (const f of r.faces) {
      const o = [slotPoint(f, 0, 0), slotPoint(f, 3, 0), slotPoint(f, 3, 3), slotPoint(f, 0, 3)];
      for (let i = 0; i < 4; i++) drawLine(out, o[i], o[(i + 1) % 4], [0, 255, 255]);
      let s = "";
      for (let cell = 0; cell < 9; cell++) {
        const c = slotPoint(f, (cell % 3) + 0.5, Math.floor(cell / 3) + 0.5);
        const named = NAMED_COLORS[nearestNamed(f.labs[cell])];
        s += f.valid[cell] ? named.id : "?";
        const col = f.valid[cell] ? hex(named.display) : [255, 0, 0];
        for (let dy = -5; dy <= 5; dy++)
          for (let dx = -5; dx <= 5; dx++) {
            const x = Math.round(c[0] + dx);
            const y = Math.round(c[1] + dy);
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            const k = (y * w + x) * 4;
            const edge = Math.abs(dx) === 5 || Math.abs(dy) === 5;
            out.data[k] = edge ? 0 : col[0];
            out.data[k + 1] = edge ? 0 : col[1];
            out.data[k + 2] = edge ? 0 : col[2];
          }
      }
      faceStr.push(`${["U", "R", "F", "D", "L", "B"][f.slot]}:${s.slice(0, 3)}/${s.slice(3, 6)}/${s.slice(6)}${f.held ? "(held)" : ""} spread=${f.spread.map((x) => Math.round(x)).join(",")}`);
    }
    summary.push(`${name}: quads=${r.quads.length} faces=${r.faces.length} ${faceStr.join(" ")}`);
    writePng(`${OUT}/${name}.png`, out);
  }
  process.stdout.write(summary.join("\n") + "\n");
}, 600000);

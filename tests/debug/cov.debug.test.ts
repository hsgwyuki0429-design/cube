import { it } from "vitest";
import { movePrior, packContext } from "../../src/track/prior";
import { moveFace } from "../../src/cube/model";
it("coverage", () => {
  const p = movePrior();
  let n = 0, d3 = 0, d4 = 0;
  const ok = (x: number, y: number) => moveFace(x) !== moveFace(y);
  for (let a = 0; a < 18; a++) for (let b = 0; b < 18; b++) for (let c = 0; c < 18; c++) for (let m = 0; m < 18; m++) {
    if (!ok(a, b) || !ok(b, c) || !ok(c, m)) continue;
    n++;
    const d = p.penalty(packContext(a, b, c), m);
    if (d === 0) d4++; else if (d < 0.3) d3++;
  }
  process.stdout.write(`valid ${n} disc4 ${(d4 / n * 100).toFixed(1)}% disc3 ${(d3 / n * 100).toFixed(1)}%\n`);
});

import { readFileSync } from "node:fs";
import { it } from "vitest";
import { LiveState, liveFrame } from "../../src/track/liveState";
import { isCenter } from "../../src/track/sight";
it("cov", () => {
  for (const name of (process.env.NAMES ?? "4972-full").split(",")) {
    const d = JSON.parse(readFileSync(`/home/user/rv/read-${name}.json`, "utf8"));
    const ref = JSON.parse(readFileSync(`/home/user/rv/ref-${name.split("-")[0]}.json`, "utf8"));
    const s0 = ref.moves[0].start, s1 = ref.moves[ref.moves.length - 1].end;
    const live = new LiveState(Uint8Array.from(d.start), 0, 0, [], null, {});
    let direct = 0, carried = 0, frames = 0, withAny = 0;
    const used = [0, 0, 0];
    for (const r of d.readings) {
      if (!r.sight) continue;
      const fr = liveFrame(r.sight, { faces: live.memory.faces.slice() }, live.options);
      live.pushSight(r.sight);
      if (r.t < s0 || r.t > s1) continue;
      frames++;
      for (const f of r.sight.faces) for (let c = 0; c < 9; c++) if (f.ids[c] >= 0 && !isCenter(f.ids[c])) { if (f.rot[c] >= 0) direct++; else carried++; }
      for (const g of fr.groups) used[g.mode] += g.to - g.from;
      if (fr.n) withAny++;
    }
    console.log(name, `frames ${frames} with-readings ${withAny} direct ${direct} carried ${carried} used sure ${used[0]} chain ${used[1]} cont ${used[2]}`);
  }
});

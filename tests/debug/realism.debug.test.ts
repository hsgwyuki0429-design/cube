import { it } from "vitest";
import { scene } from "../realism";
import { renderCube } from "../render";
import { rng, scrambled } from "../sim";
import { writePng } from "./png";

it("render realistic frames", () => {
  const out = process.env.OUT ?? "/tmp";
  const state = scrambled(rng(3));
  const cases: [string, Parameters<typeof scene>[2], [number, number, number]][] = [
    ["mild-hold", { harshness: "mild", fingers: "hold" }, [0.8, 4.5, 9]],
    ["real-hold", { harshness: "real", fingers: "hold" }, [0.8, 4.5, 9]],
    ["harsh-heavy-plaid", { harshness: "harsh", fingers: "heavy", backdrop: "plaid" }, [3, 4, 8]],
    ["real-heavy-clutter", { harshness: "real", fingers: "heavy", backdrop: "clutter" }, [0.5, 3, 9.5]],
  ];
  for (const [name, so, eye] of cases) {
    const base = { width: 640, height: 480, eye: eye as [number, number, number], orient: 0 };
    const { realism } = scene(base, 1000, so, rng(1));
    const img = renderCube({ ...base, state, seed: 5, realism });
    writePng(`${out}/${name}.png`, img);
  }
});

// 回転途中の形状認識（src/aruco/turn.ts）: 層を回している途中のフレームで、回している層と角度、各マーカーの位置を求める
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeCube, facesOverTime, reconstructFaces } from "../src/aruco/cube";
import { ArucoBench, DEFAULT_CONFIGS, type Marker } from "../src/aruco/detect";
import { type TurnShape, recognizeTurn, unwrapTurn } from "../src/aruco/turn";
import type { Pose } from "../src/vision/pose";
import { MOVE_NAMES, NORMAL, type Vec3, inverseMove, moveAmount, moveFace, parseMoves } from "../src/cube/model";
import { type CV, initOpenCv } from "../src/vision/image";
import { applyMoveStickers, renderArucoCube, solvedStickers } from "./arucoCube";

let cv: CV;
let bench: ArucoBench;
beforeAll(async () => {
  cv = await initOpenCv(createRequire(import.meta.url)("@techstark/opencv-js"));
  bench = new ArucoBench(cv, [DEFAULT_CONFIGS[1]], "unique54");
}, 120000);

const SIZE = { width: 1024, height: 768 };
const EYE: Vec3 = [2.4, 2.4, 5.5]; // 上・右・正面が見える
const deg = (r: number) => (r * 180) / Math.PI;
// 角度を -45°〜45° に（形だけでは 90° ごとの区別がつかない）
const mod90 = (d: number) => ((((d + 45) % 90) + 90) % 90) - 45;

function frame(alg: string, turn?: { move: string; fraction: number }, prev: Pose | null = null) {
  let st = solvedStickers();
  for (const m of parseMoves(alg)) st = applyMoveStickers(st, m);
  const img = renderArucoCube(cv, { ...SIZE, stickers: st, orient: 0, eye: EYE, noise: 2, scheme: "unique54", turn: turn ? { move: parseMoves(turn.move)[0], fraction: turn.fraction } : undefined });
  const markers = bench.detect(img)[0].markers;
  const faces = reconstructFaces(markers, SIZE, null, "unique54", undefined, true).faces;
  // 回している層のステッカーのうち読めたマーカーの数（正解）
  let inLayer = 0;
  if (turn) {
    const n = NORMAL[moveFace(parseMoves(turn.move)[0])];
    const ids = new Set(st.filter((x) => x.pos[0] * n[0] + x.pos[1] * n[1] + x.pos[2] * n[2] === 1).map((x) => x.id));
    inLayer = markers.filter((m) => ids.has(m.id)).length;
  }
  return { markers, inLayer, ...recognizeTurn(markers, faces, SIZE, prev) };
}

describe("回転途中の形状認識", () => {
  it("回していないフレームでは、すべてのマーカーが本体のマスに合い、回している層はない", () => {
    const r = frame("R U F' D2 L");
    expect(r.turn).toBeNull();
    expect(r.pose).not.toBeNull();
    expect(r.placed.length).toBe(r.markers.length);
    expect(r.placed.every((p) => !p.layer)).toBe(true);
  });

  // レンダラは外向きの法線のまわりに -90° × 割合 回す（外から見て時計回り）。軸の正の向きのまわりの角度に直す
  for (const [move, slot, sign] of [
    ["R", 1, -1],
    ["U", 0, -1],
    ["F", 2, -1],
    ["L", 4, 1],
    ["D", 3, 1],
  ] as const) {
    for (const fraction of [0.2, 0.35, 0.65]) {
      it(`${move} を ${Math.round(fraction * 90)}° 回した途中: 層と角度（90° ごとを除いて）が分かる（層のマーカーが 2 枚未満しか読めなければ、回していないとする）`, () => {
        const r = frame("R U F' D2 L", { move, fraction });
        if (r.inLayer < 2) {
          expect(r.turn).toBeNull();
          return;
        }
        const want = mod90(sign * 90 * fraction);
        // 1 枚のフレームでは、回した層と反対の層（とその間の層）のどちらが回ったかは、間の層のマーカーが見えないと区別できない。
        // 反対の層なら角度は逆向き（相対的な回転は同じ）
        const opposite = [3, 4, 5, 0, 1, 2][slot];
        expect([slot, opposite]).toContain(r.turn?.slot);
        const got = r.turn!.slot === slot ? deg(r.turn!.angle) : -deg(r.turn!.angle);
        expect(Math.abs(mod90(got - want))).toBeLessThan(5);
        expect(r.turn!.markers).toBeGreaterThanOrEqual(2);
        // 回している層のマーカーは、層の側（軸の座標が ±1 以上）にある
        for (const p of r.placed.filter((x) => x.layer)) expect(p.center[r.turn!.axis] * r.turn!.layer).toBeGreaterThan(0.9);
      });
    }
  }

  it("フレームをつなぐと、回した向きと量が分かる（R: -90°、U2: 180°）", () => {
    for (const [move, total] of [
      ["R", -90],
      ["U2", -180],
    ] as const) {
      let acc: ReturnType<typeof unwrapTurn> = null;
      const seen: TurnShape[] = [];
      let prev: Pose | null = frame("R U F' D2 L").pose;
      for (let k = 1; k < 10; k++) {
        const r = frame("R U F' D2 L", { move, fraction: k / 10 }, prev);
        prev = r.pose ?? prev;
        if (r.turn) seen.push(r.turn);
        acc = unwrapTurn(acc, r.turn, k * 4);
      }
      expect(seen.length).toBeGreaterThanOrEqual(6);
      // 最後に見えた途中の角度（9 割）まで
      expect(Math.abs(deg(acc!.total) - total * 0.9)).toBeLessThan(8);
    }
  });
});

describe("回転途中の形と、推定した手の照合（キューブモード）", () => {
  it("240fps 相当（90° を 12 フレーム・露光中に 7° ほど動く）で R U' F2 を回すと、回している層と向きが推定した手と合う", () => {
    const size = { width: 800, height: 600 };
    const frames: { t: number; markers: Marker[] }[] = [];
    let st = solvedStickers();
    let t = 0;
    const push = (turn?: { move: number; fraction: number; spread: number }) => {
      const img = renderArucoCube(cv, { ...size, stickers: st, orient: 0, eye: EYE, noise: 2, seed: frames.length + 1, scheme: "unique54", turn });
      frames.push({ t, markers: bench.detect(img)[0].markers });
      t += 1000 / 240;
    };
    for (let k = 0; k < 4; k++) push();
    for (const m of parseMoves("R U' F2")) {
      // U' は外から見て反時計回り（レンダラは X' を 270° 回すので、逆の手を 1 - 割合 で描く）
      // 半回転は 2 倍のフレームをかける（1 フレームに動く角度を同じに）
      const amount = moveAmount(m);
      const n = amount === 2 ? 24 : 12;
      for (let k = 1; k < n; k++) {
        const fr = k / n;
        if (amount === 3) push({ move: inverseMove(m), fraction: 1 - fr, spread: 1 / n });
        else push({ move: m, fraction: fr, spread: 1 / n });
      }
      st = applyMoveStickers(st, m);
      for (let k = 0; k < 4; k++) push();
    }
    const cf = facesOverTime(frames, size, "unique54");
    const r = decodeCube(cf, false);
    if (process.env.TURN_DBG) {
      console.log("TURNS", JSON.stringify(r.turns));
      for (const m of r.raw) console.log("MOVE", MOVE_NAMES[m.move], "o", m.orient, Math.round(m.t0 ?? -1), Math.round(m.t));
      for (const f of cf) if (f.turn) console.log("FRAME", Math.round(f.t), f.turn.slot, Math.round((f.turn.angle * 180) / Math.PI), Math.round((f.turn.total * 180) / Math.PI), f.turn.ids.length);
    }
    expect(r.moves.map((m) => MOVE_NAMES[m.move]).join(" ")).toBe("R U' F2");
    expect(cf.filter((f) => f.turn).length).toBeGreaterThan(10);
    // R と U' は層と向き、F2 は層（半回転は途中までしか見えないと、量は分からないことがある）
    expect(r.turns.seen).toBe(3);
    expect(r.turns.face).toBe(3);
    expect(r.turns.direction + r.turns.unsure).toBe(3);
    expect(r.turns.direction).toBeGreaterThanOrEqual(2);
  }, 300000);
});

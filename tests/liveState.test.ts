// ソルブ中のライブの状態の推定（src/track/liveState.ts）: 合成のキューブ（本体と同じ 4 個の配置のステッカー）を本体の認識に通した見え方で、
// 1 手ずつ・2 手まとめて・読めないフレームを挟んで回した手を追えること、1 フレームだけの読み違いを手にしないこと、
// 推定を有効にしたエンジンの TrackUpdate（手順の続き・状態・揃い）と、無効に戻したときにデコーダへ戻すこと
import { beforeAll, describe, expect, it } from "vitest";
import { ARUCO_REFS } from "../src/aruco/palette";
import { MOVE_NAMES, applyMoves, parseMoves, solvedState, statesEqual } from "../src/cube/model";
import { TrackerEngine } from "../src/track/engine";
import { LiveState } from "../src/track/liveState";
import { simplifyMoves } from "../src/track/merge";
import type { SightFrame } from "../src/track/sight";
import type { CV } from "../src/vision/image";
import { loadTestOpenCv } from "./cv";
import { EYES, sightOf as render } from "./sightRender";

let cv: CV;
beforeAll(async () => {
  cv = await loadTestOpenCv();
}, 120000);

const cache = new Map<string, SightFrame>();
const sightOf = (moves: string, t: number, eye = EYES.three): SightFrame => {
  const key = `${moves}|${eye.join()}`;
  let s = cache.get(key);
  if (!s) cache.set(key, (s = render(cv, moves, 0, eye)));
  return { ...s, t };
};
const names = (live: LiveState) => simplifyMoves(live.moves()).map((m) => MOVE_NAMES[m.move]).join(" ");

// 揃った状態から、手順の途中の状態を 1 つずつ見せる（each: 1 フレームに進める手の数）
function follow(alg: string, each: number, opts = {}): LiveState {
  const live = new LiveState(solvedState(), 0, 0, [], null, opts);
  const ms = parseMoves(alg);
  let t = 0;
  live.pushSight(sightOf("", (t += 50)));
  for (let i = each; i <= ms.length + each - 1; i += each) {
    const upto = ms.slice(0, Math.min(i, ms.length)).map((m) => MOVE_NAMES[m]).join(" ");
    live.pushSight(sightOf(upto, (t += 150)));
    live.pushSight(sightOf(upto, (t += 33)));
  }
  return live;
}

describe("ライブの状態の推定", () => {
  it("1 手ずつ回した手順を追う（上・正面・右が見える）", () => {
    const alg = "R U R' U' F' L D2 B";
    const live = follow(alg, 1);
    expect(names(live)).toBe(alg);
    expect(live.known()).toBe(true);
    expect(statesEqual(live.stateOf(live.best()), applyMoves(solvedState(), alg))).toBe(true);
  }, 120000);

  it("フレームの間に 2 手・3 手回しても追う", () => {
    const alg = "R U R' U' R' F R2 U'";
    for (const each of [2, 3]) {
      const live = follow(alg, each);
      expect(statesEqual(live.stateOf(live.best()), applyMoves(solvedState(), alg)), `${each} 手ずつ: ${names(live)}`).toBe(true);
    }
  }, 120000);

  it("1 フレームだけの読み違い（ステッカー 1 枚の ID）を手にしない", () => {
    const live = new LiveState(solvedState(), 0, 0, [], null);
    const good = sightOf("R U", 0);
    live.pushSight(sightOf("", 0));
    live.pushSight({ ...good, t: 150 });
    // 正面の端のマスの ID を、ほかのステッカーに変える
    const bad: SightFrame = { ...good, t: 183, faces: good.faces.map((f, k) => (k === 0 ? { ...f, ids: f.ids.map((id, c) => (c === 0 && id >= 0 ? (id + 9) % 54 : id)) } : f)) };
    live.pushSight(bad);
    live.pushSight({ ...good, t: 216 });
    live.pushSight({ ...good, t: 250 });
    expect(names(live)).toBe("R U");
  }, 120000);

  it("エンジン: 有効にした時点の手順の続きを出し、無効にしたらデコーダに戻す", () => {
    const engine = new TrackerEngine(solvedState(), ARUCO_REFS, { pieces: false });
    // 推定の前は今までの追跡（観測は面の読みから。ここでは推定だけを見るので、すぐ切り替える）
    engine.setOptions({ pieces: true });
    expect(engine.live).not.toBeNull();
    const ms = parseMoves("R U R'");
    let t = 0;
    let last = null;
    for (let i = 1; i <= ms.length; i++) {
      const s = sightOf(ms.slice(0, i).map((m) => MOVE_NAMES[m]).join(" "), (t += 200));
      last = engine.push({ t, faces: [] }, s) ?? last;
    }
    expect(last).not.toBeNull();
    expect(last!.moves.map((m) => MOVE_NAMES[m.move]).join(" ")).toBe("R U R'");
    expect(statesEqual(Uint8Array.from(last!.state), applyMoves(solvedState(), "R U R'"))).toBe(true);
    expect(last!.agreed).toBeDefined();
    engine.setOptions({ pieces: false });
    expect(engine.live).toBeNull();
    expect(engine.decoder.bestMoves().map((m) => MOVE_NAMES[m.move]).join(" ")).toBe("R U R'");
    expect(statesEqual(engine.decoder.best().state, applyMoves(solvedState(), "R U R'"))).toBe(true);
  }, 120000);

  it("揃えたら揃い", () => {
    const live = follow("R U R' U'", 1);
    const back = "U R U' R'";
    let t = 10000;
    const ms = parseMoves(back);
    for (let i = 1; i <= ms.length; i++) {
      const upto = `R U R' U' ${ms.slice(0, i).map((m) => MOVE_NAMES[m]).join(" ")}`;
      live.pushSight(sightOf(upto, (t += 150)));
    }
    expect(live.solved()).toBe(true);
  }, 120000);
});

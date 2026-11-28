import { describe, expect, it } from "vitest";
import type { Hypothesis } from "../src/track/decoder";
import { DirTracker, ShowFeed } from "../src/vision/showFeed";
import type { ShowMessage } from "../src/vision/showProtocol";
import { LiveReads, directCells } from "../src/app/liveReads";
import { readBins } from "../src/app/stopShow";

type Node = NonNullable<Hypothesis["tail"]>;
const node = (prev: Node | null, move = 0): Node => ({ move, t0: 0, t: 0, orient: 0, inferred: false, prev, len: (prev?.len ?? 0) + 1 });
const hyp = (tail: Node | null, cost = 0, obsCost = 0): Hypothesis => ({ state: new Uint8Array(54), orient: 0, cost, obsCost, tail });

describe("止めた後の画面の知らせ（Worker 側）", () => {
  it("落とした仮説・有力な枝・見失った所で止まる時刻", () => {
    const d = new DirTracker();
    const a = node(null);
    const b = node(null, 1);
    d.step(100, [hyp(a, 0), hyp(b, 1)]);
    expect(d.show()).toMatchObject({ t: 100, hyps: 2, near: 2, dropped: 0 });
    // b の子だけ残る（a は落ちた）。コスト 5 の仮説は有力でない
    d.step(200, [hyp(node(b), 0), hyp(b, 5)]);
    expect(d.show()).toMatchObject({ t: 200, hyps: 2, near: 1, dropped: 1 });
    // 見失う（矛盾 3 以上）が 3 つ続いたら、時刻は見失う前で止まる
    d.step(300, [hyp(b, 0, 4)]);
    d.step(400, [hyp(b, 0, 4)]);
    expect(d.show().t).toBe(400);
    d.step(500, [hyp(b, 0, 4)]);
    expect(d.show().t).toBe(200);
    d.step(600, [hyp(b, 0, 0)]);
    expect(d.show().t).toBe(600);
  });

  it("1 秒 10 回まで・読んだマスの合計と枚数・段が変わったらすぐ送る", () => {
    const out: ShowMessage[] = [];
    let now = 0;
    const feed = new ShowFeed((m) => out.push(m), 7, () => ({ done: 3, total: 9 }), () => now);
    const face = { slot: 2, ids: [18, 19, -1, 21, 22, 23, 24, 25, 26], shift: [[0, 0], null, null, [0, 0], [0, 0], null, null, null, null] as ([number, number] | null)[] };
    feed.frame(10, { faces: [face] });
    now = 50;
    feed.frame(20, { faces: [face] });
    now = 120;
    feed.frame(30, { faces: [face] });
    expect(out.length).toBe(2);
    const r = out[1];
    expect(r.kind).toBe("read");
    if (r.kind !== "read") return;
    expect(r).toMatchObject({ token: 7, t: 30, cells: 3, sum: 6, n: 2, t0: 20, t1: 30, done: 3, total: 9 });
    expect(r.ids[2 * 9]).toBe(18);
    expect(r.ids[2 * 9 + 1]).toBe(-1); // ID はあるが直接は読んでいない
    // 読んでいる間の前向きは送らない。解き直しが始まったらすぐ送る
    feed.search("read", { dir: "f", t: 40, hyps: [hyp(null)] });
    expect(out.length).toBe(2);
    feed.search("first", { dir: "b", t: 900, hyps: [hyp(null), hyp(null, 1)], meetT: null });
    expect(out.length).toBe(3);
    const s = out[2];
    expect(s.kind === "search" && s.f.t === 40 && s.b.t === 900 && s.b.hyps === 2 && s.stage === "first").toBe(true);
    // 間引く・深い 2 回目はすぐ・前向きはやり直す
    feed.search("first", { dir: "b", t: 800, hyps: [hyp(null)], meetT: 800 });
    expect(out.length).toBe(3);
    feed.search("deep", { dir: "f", t: 50, hyps: [hyp(null)] });
    expect(out.length).toBe(4);
    const d = out[3];
    expect(d.kind === "search" && d.stage === "deep" && d.f.steps === 1 && d.b.t === null).toBe(true);
    feed.end();
    expect(out.length).toBe(5);
  });
});

describe("ライブが読んだマス・区間ごとの濃さ", () => {
  it("直接読めた（向きのある）マスだけ、開始〜停止の間を足す", () => {
    const sight = { t: 0, faces: [{ slot: 2, ids: [1, 2, 3, -1, 5, 6, 7, 8, 9], rot: [0, 1, -1, 0, -1, -1, -1, -1, -1], quad: [] }] };
    expect(directCells(sight)).toBe(2);
    const lr = new LiveReads();
    lr.push(100, sight);
    lr.push(200, undefined);
    lr.push(300, sight);
    expect(lr.sum(150, 300)).toEqual({ cells: 2, frames: 2 });
  });

  it("区間ごとの 1 フレームあたり", () => {
    const bins = readBins([{ t0: 0, t1: 10, sum: 10, n: 2 }, { t0: 90, t1: 100, sum: 3, n: 3 }], 0, 100, 2);
    expect(bins).toEqual([5, 1]);
    expect(readBins([], 0, 100, 3)).toEqual([null, null, null]);
  });
});

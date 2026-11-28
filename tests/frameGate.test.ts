// カメラのフレームを VideoFrame のまま渡すか、今までのやり方に戻すか（src/vision/frameGate.ts）。
// 一時的な失敗（映像のフレームがまだない）では戻さず、映像があるのに続けて失敗したときだけ戻す
import { describe, expect, it, vi } from "vitest";
import { FrameGate, HAVE_CURRENT_DATA, MAX_FAILS, type VideoLike } from "../src/vision/frameGate";

const fakeFrame = () => ({ close: vi.fn() }) as unknown as VideoFrame;
const video = (readyState: number): VideoLike => ({ readyState, videoWidth: 1280, videoHeight: 720 });
const invalidState = () => Object.assign(new Error("Video element has no video frame"), { name: "InvalidStateError" });

function gate(create: (v: VideoLike) => VideoFrame): FrameGate {
  const g = new FrameGate("test", (v) => create(v));
  g.enabled = true;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return g;
}

describe("FrameGate", () => {
  it("映像のフレームがまだない（readyState が HAVE_CURRENT_DATA より前）なら作らずに待ち、戻さない", () => {
    const create = vi.fn(fakeFrame);
    const g = gate(create);
    for (let i = 0; i < MAX_FAILS * 3; i++) expect(g.make(video(1), i).kind).toBe("wait");
    expect(create).not.toHaveBeenCalled();
    expect(g.enabled).toBe(true);
    expect(g.waits).toBe(MAX_FAILS * 3);
    expect(g.make(video(HAVE_CURRENT_DATA), 0).kind).toBe("frame");
  });

  it("映像の大きさがまだ 0 なら待つ", () => {
    const g = gate(fakeFrame);
    expect(g.make({ readyState: 4, videoWidth: 0, videoHeight: 0 }, 0).kind).toBe("wait");
    expect(g.enabled).toBe(true);
  });

  it("映像が届く前の InvalidStateError では戻さない（iPhone の書き出しで起きていたこと）", () => {
    let ready = false;
    const g = gate(() => {
      if (!ready) throw invalidState();
      return fakeFrame();
    });
    // readyState は進んでいるのにまだフレームがない: 1 回の失敗では戻さない
    expect(g.make(video(HAVE_CURRENT_DATA), 0).kind).toBe("wait");
    expect(g.enabled).toBe(true);
    expect(g.note).toBeNull();
    expect(g.waitNote).toContain("InvalidStateError");
    ready = true;
    const r = g.make(video(4), 1);
    expect(r.kind).toBe("frame");
    g.sent();
    expect(g.enabled).toBe(true);
  });

  it("作るときに readyState が戻っていたら失敗を数えない", () => {
    const v = video(4);
    const g = gate(() => {
      v.readyState = 1; // 作っている間に映像が止まった
      throw invalidState();
    });
    for (let i = 0; i < MAX_FAILS * 2; i++) {
      v.readyState = 4;
      expect(g.make(v, i).kind).toBe("wait");
    }
    expect(g.enabled).toBe(true);
  });

  it("映像があるのに続けて作れなければ戻す（MAX_FAILS 回目）", () => {
    const g = gate(() => {
      throw invalidState();
    });
    for (let i = 1; i < MAX_FAILS; i++) expect(g.make(video(4), i).kind).toBe("wait");
    expect(g.enabled).toBe(true);
    expect(g.make(video(4), MAX_FAILS).kind).toBe("off");
    expect(g.enabled).toBe(false);
    expect(g.note).toContain(`${MAX_FAILS} 回続けて`);
    // 戻した後は作らない
    expect(g.make(video(4), 0).kind).toBe("off");
  });

  it("途中で作れたら続けて失敗した回数を戻す", () => {
    let n = 0;
    const g = gate(() => {
      n++;
      if (n % (MAX_FAILS - 1) === 0) return fakeFrame();
      throw invalidState();
    });
    for (let i = 0; i < MAX_FAILS * 5; i++) {
      const r = g.make(video(4), i);
      if (r.kind === "frame") g.sent();
      expect(r.kind).not.toBe("off");
    }
    expect(g.enabled).toBe(true);
  });

  it("渡せない（postMessage の失敗）も同じ数え方: 続けば戻す", () => {
    const g = gate(fakeFrame);
    for (let i = 1; i < MAX_FAILS; i++) {
      expect(g.make(video(4), i).kind).toBe("frame");
      expect(g.sendFailed(video(4), new Error("DataCloneError")).kind).toBe("wait");
    }
    expect(g.enabled).toBe(true);
    expect(g.make(video(4), 0).kind).toBe("frame");
    expect(g.sendFailed(video(4), new Error("DataCloneError")).kind).toBe("off");
    expect(g.enabled).toBe(false);
    expect(g.note).toContain("送れない");
  });

  it("VideoFrame がなければ戻す", () => {
    const g = new FrameGate("test", null);
    g.enabled = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(g.make(video(4), 0).kind).toBe("off");
    expect(g.enabled).toBe(false);
    expect(g.note).toBe("VideoFrame がない");
  });

  it("Worker で描けないと分かったら戻す（disable）・はじめから使わないなら作らない", () => {
    const create = vi.fn(fakeFrame);
    const g = gate(create);
    g.disable("Worker で描けない: x");
    expect(g.enabled).toBe(false);
    expect(g.make(video(4), 0).kind).toBe("off");
    const off = new FrameGate("test", create);
    expect(off.make(video(4), 0).kind).toBe("off");
    expect(off.note).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});

// 録画を圧縮し直さずに MP4 にまとめる（src/vision/mp4Mux.ts）: 本体の動画の読み込み（mp4box の demux）で、フレームの数・時刻・キーフレーム・
// 中身（長さ付きの NAL）・avcC・書き出しのメタデータがそのまま読めること
import { describe, expect, it } from "vitest";
import { demuxFile } from "../src/aruco/demux";
import { LIVE_LOG_UUID, muxRecording, readRecordingMeta, readUuidBox, splitAnnexB } from "../src/vision/mp4Mux";
import type { Recording } from "../src/vision/recorder";

const SPS = Uint8Array.of(0x67, 0x42, 0x00, 0x20, 0x95, 0xa0, 0x28, 0x0f, 0x68);
const PPS = Uint8Array.of(0x68, 0xce, 0x38, 0x80);
const annexB = (...nals: Uint8Array[]) => {
  const out: number[] = [];
  nals.forEach((n, i) => out.push(...(i === 0 ? [0, 0, 0, 1] : [0, 0, 1]), ...n));
  return Uint8Array.from(out).buffer;
};
const slice = (key: boolean, k: number) => Uint8Array.of(key ? 0x65 : 0x41, 0x88, k, 0x00, 0x00, 0x00, k + 1); // 中に 00 00 00 を含む

function recording(): Recording {
  const t0 = 123_456_789; // µs（performance.now() の時間軸）
  const times = [0, 16_667, 33_333, 50_000, 83_333, 100_000]; // 66.7ms の所は 1 枚抜けている
  return {
    config: { codec: "avc1.420020", codedWidth: 1280, codedHeight: 720 },
    width: 1280,
    height: 720,
    chunks: times.map((dt, i) => {
      const key = i === 0 || i === 4;
      return { type: key ? ("key" as const) : ("delta" as const), timestamp: t0 + dt, duration: 0, data: key ? annexB(Uint8Array.of(0x09, 0xf0), SPS, PPS, slice(true, i)) : annexB(slice(false, i)) };
    }),
  };
}

describe("mp4Mux", () => {
  it("Annex B を NAL に分ける（00 00 00 01・00 00 01）", () => {
    const nals = splitAnnexB(new Uint8Array(annexB(SPS, PPS, slice(true, 3))));
    expect(nals.map((n) => Array.from(n))).toEqual([Array.from(SPS), Array.from(PPS), Array.from(slice(true, 3))]);
  });

  it("H.264 の録画を MP4 にして、本体の demux で同じフレーム・時刻・キーフレームに読める", async () => {
    const rec = recording();
    const m = muxRecording(rec, { kind: "test", n: 1, inf: Infinity, ninf: -Infinity, u8: Uint8Array.of(3, 4) });
    expect(m.frames).toBe(6);
    expect(m.timeOriginUs).toBe(123_456_789);
    const file = new Blob(m.parts as BlobPart[]);
    const d = await demuxFile(file);
    expect(d.codec).toBe("avc1.420020");
    expect([d.width, d.height]).toEqual([1280, 720]);
    expect(d.samples.map((s) => Math.round(s.cts))).toEqual(rec.chunks.map((c) => c.timestamp - rec.chunks[0].timestamp));
    expect(d.samples.map((s) => s.key)).toEqual([true, false, false, false, true, false]);
    // avcC: 版 1・profile/compat/level は SPS から・SPS と PPS が 1 つずつ
    const desc = d.config.description as Uint8Array;
    expect(Array.from(desc.subarray(0, 6))).toEqual([1, 0x42, 0x00, 0x20, 0xff, 0xe1]);
    // 中身: AUD・SPS・PPS を除き、4 バイトの長さ付きの NAL
    const buf = new Uint8Array(await file.arrayBuffer());
    const s4 = d.samples[4];
    const data = buf.subarray(s4.offset, s4.offset + s4.size);
    const nal = slice(true, 4);
    expect(Array.from(data)).toEqual([0, 0, 0, nal.length, ...nal]);
    expect(readRecordingMeta(buf)).toEqual({ kind: "test", n: 1, inf: Infinity, ninf: -Infinity, u8: [3, 4], timeOriginUs: 123_456_789 });
  });

  it("ライブの記録を足したまとめたファイル: 同じフレームに読め、メタデータとライブの記録の両方を取り出せる", async () => {
    const rec = recording();
    const live = Uint8Array.of(0x1f, 0x8b, 1, 2, 3, 4, 5);
    const m = muxRecording(rec, { kind: "test" }, [{ uuid: LIVE_LOG_UUID, data: live }]);
    const file = new Blob(m.parts as BlobPart[]);
    const d = await demuxFile(file);
    expect(d.samples).toHaveLength(6);
    const buf = new Uint8Array(await file.arrayBuffer());
    expect(readRecordingMeta(buf)).toEqual({ kind: "test", timeOriginUs: 123_456_789 });
    expect(Array.from(readUuidBox(buf, LIVE_LOG_UUID)!)).toEqual(Array.from(live));
    expect(readUuidBox(new Uint8Array(await new Blob(muxRecording(rec).parts as BlobPart[]).arrayBuffer()), LIVE_LOG_UUID)).toBeNull();
    expect(() => muxRecording(rec, {}, [{ uuid: "short", data: live }])).toThrow();
  });

  it("ふつうの動画（メタデータなし）は null", () => {
    const rec = recording();
    const m = muxRecording(rec);
    const parts = m.parts.slice(0, -1); // uuid ボックスを除く
    const buf = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let o = 0;
    for (const p of parts) {
      buf.set(p, o);
      o += p.byteLength;
    }
    expect(readRecordingMeta(buf)).toBeNull();
  });

  it("VP8 は vp08 として読める", async () => {
    const rec: Recording = { config: { codec: "vp8" }, width: 640, height: 480, chunks: [0, 33_000].map((dt, i) => ({ type: i ? ("delta" as const) : ("key" as const), timestamp: 5_000 + dt, duration: 33_000, data: Uint8Array.of(1, 2, 3, i).buffer })) };
    const d = await demuxFile(new Blob(muxRecording(rec).parts as BlobPart[]));
    expect(d.codec.startsWith("vp08")).toBe(true);
    expect(d.samples.map((s) => Math.round(s.cts))).toEqual([0, 33_000]);
  });
});

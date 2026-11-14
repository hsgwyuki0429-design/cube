// GAN Smart Timer の知らせの読み方（src/app/ganTimer.ts）
import { describe, expect, it } from "vitest";
import { PadState, crc16ccitt, parsePadEvent } from "../src/app/ganTimer";

// 知らせを作る: 0xFE・長さ・種類・状態・中身・CRC（3 バイト目からの CRC-16/CCITT、リトルエンディアン）
function packet(state: number, payload: number[] = []): DataView {
  const body = [0x01, state, ...payload];
  const bytes = [0xfe, body.length + 4, ...body];
  const crc = crc16ccitt(Uint8Array.from(bytes.slice(2)));
  return new DataView(Uint8Array.from([...bytes, crc & 0xff, crc >> 8]).buffer);
}

describe("GAN タイマー", () => {
  it("CRC-16/CCITT（0xFFFF から）", () => {
    expect(crc16ccitt(new TextEncoder().encode("123456789"))).toBe(0x29b1);
  });
  it("状態を読む", () => {
    expect(parsePadEvent(packet(PadState.RUNNING))).toEqual({ state: PadState.RUNNING });
    expect(parsePadEvent(packet(PadState.GET_SET))).toEqual({ state: PadState.GET_SET });
  });
  it("止まったときのタイム（分・秒・ミリ秒）", () => {
    // 1 分 2 秒 345
    expect(parsePadEvent(packet(PadState.STOPPED, [1, 2, 345 & 0xff, 345 >> 8])))?.toEqual({ state: PadState.STOPPED, timeMs: 62345 });
  });
  it("形が違う・CRC が合わなければ捨てる", () => {
    const p = packet(PadState.RUNNING);
    p.setUint8(3, PadState.STOPPED);
    expect(parsePadEvent(p)).toBeNull();
    expect(parsePadEvent(new DataView(Uint8Array.from([0x00, 1, 2, 3, 4, 5]).buffer))).toBeNull();
  });
});

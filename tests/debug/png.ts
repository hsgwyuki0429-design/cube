// デバッグ用の最小 PNG エンコーダ
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf: Uint8Array): number {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function writePng(path: string, img: { data: Uint8ClampedArray; width: number; height: number }) {
  const { width: w, height: h, data } = img;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]));
}
export function drawLine(img: { data: Uint8ClampedArray; width: number; height: number }, a: [number, number], b: [number, number], c: [number, number, number]) {
  const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]));
  for (let i = 0; i <= n; i++) {
    const x = Math.round(a[0] + ((b[0] - a[0]) * i) / (n || 1));
    const y = Math.round(a[1] + ((b[1] - a[1]) * i) / (n || 1));
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
    const k = (y * img.width + x) * 4;
    img.data[k] = c[0];
    img.data[k + 1] = c[1];
    img.data[k + 2] = c[2];
  }
}

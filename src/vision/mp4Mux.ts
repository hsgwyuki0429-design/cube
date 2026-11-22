// 録画（WebCodecs で圧縮したまま: src/vision/recorder.ts の Recording）を、圧縮し直さずに MP4 にまとめる。開発用の「録画を書き出す」
// （src/ui/recordingExport.ts）で使い、手元で ffmpeg・realVideo にそのまま通す。DOM もカメラも知らない（Node のテストでも動く）。
// - H.264（Annex B: キーフレームに SPS・PPS）は avcC を作り、各フレームを長さ付きの NAL に直す（中身はそのまま）。AVCC で出ていれば
//   （decoderConfig.description）そのまま。VP8・VP9 は vpcC
// - 時刻の単位は µs（mdhd の timescale 1,000,000）。最初のフレームを 0 にし、元の時刻（performance.now() の時間軸の µs）は
//   メタデータの timeOriginUs に入れる。リアルタイムの圧縮は B フレームがないので、復号の順 = 表示の順
// - メタデータ（録画の設定・タイマーの時刻・精密解析の結果）は最上位の uuid ボックス（RECORDING_UUID）に JSON で入れる。ffmpeg・
//   動画のアプリは知らないボックスを読み飛ばすので、ふつうの動画としても見られる
import type { Recording } from "./recorder";

export const RECORDING_UUID = "cubevision-rec01"; // 16 文字（uuid ボックスの 16 バイト）
const enc = new TextEncoder();

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}
function u16(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff);
  return b;
}
function cat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}
function box(type: string, ...body: Uint8Array[]): Uint8Array {
  const content = cat(body);
  return cat([u32(content.byteLength + 8), enc.encode(type), content]);
}
function fullBox(type: string, version: number, flags: number, ...body: Uint8Array[]): Uint8Array {
  return box(type, Uint8Array.of(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...body);
}
const zeros = (n: number) => new Uint8Array(n);
const MATRIX = cat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

// Annex B（00 00 01 / 00 00 00 01 で区切った NAL）を NAL ごとに分ける
export function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = -1;
  let i = 0;
  while (i + 2 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        while (end > start && data[end - 1] === 0) end--; // 00 00 00 01 の前の 0
        out.push(data.subarray(start, end));
      }
      i += 3;
      start = i;
    } else i++;
  }
  if (start >= 0 && start < data.length) out.push(data.subarray(start));
  return out;
}

// 映像を Annex B で受け取ったか（4 バイトの長さ付き = AVCC なら false）
function isAnnexB(data: Uint8Array): boolean {
  return data.length > 4 && data[0] === 0 && data[1] === 0 && (data[2] === 1 || (data[2] === 0 && data[3] === 1));
}

function avcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  return box("avcC", Uint8Array.of(1, sps[1], sps[2], sps[3], 0xff, 0xe1), u16(sps.length), sps, Uint8Array.of(1), u16(pps.length), pps);
}

// VP8・VP9 の vpcC（版 1）。codec 文字列の profile・level・bit 深さ（vp09.PP.LL.DD）。VP8 は 0・10・8
function vpcC(codec: string): Uint8Array {
  const parts = codec.split(".");
  const profile = parts[0] === "vp09" ? Number(parts[1] ?? 0) : 0;
  const level = parts[0] === "vp09" ? Number(parts[2] ?? 10) : 10;
  const depth = parts[0] === "vp09" ? Number(parts[3] ?? 8) : 8;
  // bitDepth(4) chromaSubsampling(3: 1 = 4:2:0 colocated) fullRange(1)、色の決まりは BT.709
  return fullBox("vpcC", 1, 0, Uint8Array.of(profile, level, (depth << 4) | (1 << 1), 1, 1, 1), u16(0));
}

function visualEntry(type: string, width: number, height: number, child: Uint8Array): Uint8Array {
  return box(type, zeros(6), u16(1), zeros(16), u16(width), u16(height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), zeros(32), u16(0x18), u16(0xffff), child);
}

export interface MuxedRecording {
  parts: Uint8Array[]; // ファイルの中身（Blob にするときはそのまま並べる）
  frames: number;
  timeOriginUs: number; // 最初のフレームの元の時刻（µs）
  durationUs: number;
}

// meta: uuid ボックスに入れる JSON（timeOriginUs は自動で足す）
export function muxRecording(rec: Recording, meta: Record<string, unknown> = {}): MuxedRecording {
  const codec = rec.config.codec;
  const h264 = codec.startsWith("avc1") || codec.startsWith("avc3");
  const samples: Uint8Array[] = [];
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  const d = rec.config.description;
  const desc = !d ? null : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array((d as ArrayBufferView).buffer, (d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteLength);
  for (const c of rec.chunks) {
    const data = new Uint8Array(c.data);
    if (!h264 || (desc && !isAnnexB(data))) {
      samples.push(data);
      continue;
    }
    const parts: Uint8Array[] = [];
    for (const nal of splitAnnexB(data)) {
      const type = nal[0] & 0x1f;
      if (type === 7) sps ??= nal;
      else if (type === 8) pps ??= nal;
      else if (type !== 9) parts.push(u32(nal.length), nal); // 9 = AUD
    }
    samples.push(cat(parts));
  }
  let entry: Uint8Array;
  if (h264) {
    const config = desc ? box("avcC", desc) : sps && pps ? avcC(sps, pps) : null;
    if (!config) throw new Error("H.264 の SPS・PPS が録画にありません");
    entry = visualEntry("avc1", rec.width, rec.height, config);
  } else if (codec.startsWith("vp8")) entry = visualEntry("vp08", rec.width, rec.height, vpcC(codec));
  else if (codec.startsWith("vp09")) entry = visualEntry("vp09", rec.width, rec.height, vpcC(codec));
  else throw new Error(`この形式の録画は書き出せません（${codec}）`);

  const n = rec.chunks.length;
  if (!n) throw new Error("録画が空です");
  const t0 = rec.chunks[0].timestamp;
  // 1 フレームの長さ（次のフレームとの差。最後は記録された長さか、前の差）
  const deltas: number[] = [];
  for (let i = 0; i < n; i++) {
    const next = i + 1 < n ? rec.chunks[i + 1].timestamp - rec.chunks[i].timestamp : rec.chunks[i].duration || deltas[i - 1] || 16667;
    deltas.push(Math.max(1, Math.round(next)));
  }
  const durationUs = deltas.reduce((a, b) => a + b, 0);
  const stts: Uint8Array[] = [];
  let runs = 0;
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && deltas[j + 1] === deltas[i]) j++;
    stts.push(u32(j - i + 1), u32(deltas[i]));
    runs++;
    i = j + 1;
  }
  const keys: Uint8Array[] = [];
  rec.chunks.forEach((c, i) => {
    if (c.type === "key") keys.push(u32(i + 1));
  });
  const ftyp = box("ftyp", enc.encode("isom"), u32(0x200), enc.encode("isomiso2avc1mp41"));
  let mdatSize = 8;
  for (const s of samples) mdatSize += s.byteLength;
  const chunkOffset = ftyp.byteLength + 8;
  const durationMs = Math.round(durationUs / 1000);
  const stbl = box(
    "stbl",
    fullBox("stsd", 0, 0, u32(1), entry),
    fullBox("stts", 0, 0, u32(runs), ...stts),
    fullBox("stss", 0, 0, u32(keys.length), ...keys),
    fullBox("stsc", 0, 0, u32(1), u32(1), u32(n), u32(1)),
    fullBox("stsz", 0, 0, u32(0), u32(n), ...samples.map((s) => u32(s.byteLength))),
    fullBox("stco", 0, 0, u32(1), u32(chunkOffset)),
  );
  const minf = box("minf", fullBox("vmhd", 0, 1, zeros(8)), box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1))), stbl);
  const mdia = box(
    "mdia",
    fullBox("mdhd", 0, 0, u32(0), u32(0), u32(1_000_000), u32(durationUs), u16(0x55c4), u16(0)),
    fullBox("hdlr", 0, 0, u32(0), enc.encode("vide"), zeros(12), enc.encode("VideoHandler\0")),
    minf,
  );
  const tkhd = fullBox("tkhd", 0, 3, u32(0), u32(0), u32(1), u32(0), u32(durationMs), zeros(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(rec.width * 65536), u32(rec.height * 65536));
  const mvhd = fullBox("mvhd", 0, 0, u32(0), u32(0), u32(1000), u32(durationMs), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(2));
  const moov = box("moov", mvhd, box("trak", tkhd, mdia));
  const json = enc.encode(stringifyMeta({ ...meta, timeOriginUs: t0 }));
  const uuid = box("uuid", enc.encode(RECORDING_UUID), json);
  return { parts: [ftyp, u32(mdatSize), enc.encode("mdat"), ...samples, moov, uuid], frames: n, timeOriginUs: t0, durationUs };
}

// メタデータの JSON: 解析の入力・結果には Infinity・-Infinity（JSON では null になる）や型付きの配列があるので、そのまま戻せる形にする
export function stringifyMeta(meta: unknown): string {
  return JSON.stringify(meta, (_k, v: unknown) => (typeof v === "number" && !Number.isFinite(v) ? { $num: String(v) } : ArrayBuffer.isView(v) && !(v instanceof DataView) ? Array.from(v as unknown as ArrayLike<number>) : v));
}

export function parseMeta(text: string): Record<string, unknown> {
  return JSON.parse(text, (_k, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as { $num?: unknown }).$num === "string" ? Number((v as { $num: string }).$num) : v)) as Record<string, unknown>;
}

// MP4 の最上位のボックスをたどって、書き出しのメタデータ（uuid ボックスの JSON）を読む。なければ null（ふつうの動画）
export function readRecordingMeta(file: Uint8Array): Record<string, unknown> | null {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const dec = new TextDecoder();
  let pos = 0;
  while (pos + 8 <= file.byteLength) {
    let size = view.getUint32(pos);
    const type = dec.decode(file.subarray(pos + 4, pos + 8));
    let head = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(pos + 8));
      head = 16;
    } else if (size === 0) size = file.byteLength - pos;
    if (size < head) return null;
    if (type === "uuid" && dec.decode(file.subarray(pos + head, pos + head + 16)) === RECORDING_UUID) {
      return parseMeta(dec.decode(file.subarray(pos + head + 16, pos + size)));
    }
    pos += size;
  }
  return null;
}

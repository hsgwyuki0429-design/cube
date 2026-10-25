// 動画ファイル（MP4 / MOV）を分解して、WebCodecs で 1 フレームずつ復号できる形にする。
// スマホのスロー撮影（240fps）は数百 MB になるので、全体を読み込まない: 先頭からボックスの見出しだけを
// たどって moov（サンプル表）を読み、各フレームのデータは復号するときにファイルの該当部分だけ読む。
import { DataStream, Endianness, MP4BoxBuffer, createFile } from "mp4box";

export interface DemuxedSample {
  offset: number;
  size: number;
  cts: number; // 表示時刻（µs、ファイルの時刻のまま）
  dts: number;
  duration: number; // µs
  key: boolean;
}

export interface Demuxed {
  codec: string;
  width: number; // 符号化された大きさ（回転前）
  height: number;
  rotation: 0 | 90 | 180 | 270; // 表示するときの時計回りの回転（縦向きで撮った動画は 90 など）
  config: VideoDecoderConfig;
  samples: DemuxedSample[]; // 復号順
  firstCts: number; // 最初に表示されるフレームの時刻（µs）
  fps: number; // ファイルの時刻での fps（スロー再生用に書き出された動画は実際の撮影 fps と違う）
  durationMs: number;
}

const CHUNK = 4 * 1024 * 1024;

export async function demuxFile(file: Blob): Promise<Demuxed> {
  const mp4 = createFile(false); // mdat（映像データ）は持たない
  let ready: ReturnType<typeof mp4.getInfo> | null = null;
  let failure: string | null = null;
  mp4.onReady = (info) => {
    ready = info;
  };
  mp4.onError = (mod, msg) => {
    failure = `${mod}: ${msg}`;
  };
  let pos = 0;
  while (!ready && !failure && pos < file.size) {
    const end = Math.min(file.size, pos + CHUNK);
    const ab = await file.slice(pos, end).arrayBuffer();
    const next = mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ab, pos), end >= file.size);
    // mdat の見出しを読むと、その後ろ（次のボックス）の位置を返す
    pos = next > pos ? next : end;
  }
  if (!ready) mp4.flush();
  if (failure) throw new Error(`動画を読めませんでした（${failure}）`);
  const info = ready as ReturnType<typeof mp4.getInfo> | null;
  if (!info) throw new Error("動画の情報（moov）が見つかりませんでした。MP4 / MOV ファイルを選んでください");
  const track = info.videoTracks[0];
  if (!track) throw new Error("映像のトラックがありません");

  const trak = mp4.getTrackById(track.id);
  let description: Uint8Array | undefined;
  for (const entry of trak.mdia.minf.stbl.stsd.entries as any[]) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      box.write(stream);
      description = new Uint8Array(stream.buffer, 8); // ボックスの見出し（8 バイト）を除く
      break;
    }
  }

  const raw = mp4.getTrackSamplesInfo(track.id);
  if (!raw.length) throw new Error("フレームがありません");
  const samples: DemuxedSample[] = raw.map((s) => ({
    offset: s.offset,
    size: s.size,
    cts: (s.cts * 1e6) / s.timescale,
    dts: (s.dts * 1e6) / s.timescale,
    duration: (s.duration * 1e6) / s.timescale,
    key: s.is_sync,
  }));
  const pts = samples.map((s) => s.cts).sort((a, b) => a - b);
  const diffs: number[] = [];
  for (let i = 1; i < pts.length; i++) diffs.push(pts[i] - pts[i - 1]);
  diffs.sort((a, b) => a - b);
  const dt = diffs.length ? diffs[diffs.length >> 1] : 1e6 / 30;

  const width = track.video?.width ?? track.track_width;
  const height = track.video?.height ?? track.track_height;
  return {
    codec: track.codec,
    width,
    height,
    rotation: rotationOf(track.matrix as unknown as ArrayLike<number>),
    config: { codec: track.codec, codedWidth: width, codedHeight: height, description },
    samples,
    firstCts: pts[0],
    fps: 1e6 / dt,
    durationMs: (pts[pts.length - 1] - pts[0] + dt) / 1000,
  };
}

// tkhd の表示行列（16.16 固定小数点の a b u / c d v / x y w）から、時計回りの回転
export function rotationOf(m: ArrayLike<number> | undefined): 0 | 90 | 180 | 270 {
  if (!m || m.length < 4) return 0;
  const deg = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
  const r = (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
  return r as 0 | 90 | 180 | 270;
}

// 復号順のサンプルを、まとめて読める範囲ごとに読み出す（連続していれば 1 回の読み込み）
export async function* readSamples(file: Blob, samples: DemuxedSample[], from = 0): AsyncGenerator<{ index: number; data: Uint8Array }> {
  let i = from;
  while (i < samples.length) {
    const start = samples[i].offset;
    let end = start + samples[i].size;
    let j = i + 1;
    while (j < samples.length && samples[j].offset === end && end - start < CHUNK) {
      end += samples[j].size;
      j++;
    }
    const buf = new Uint8Array(await file.slice(start, end).arrayBuffer());
    for (let k = i; k < j; k++) {
      const o = samples[k].offset - start;
      yield { index: k, data: buf.subarray(o, o + samples[k].size) };
    }
    i = j;
  }
}

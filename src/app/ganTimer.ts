// GAN Smart Timer（Bluetooth）とつなぐ。iOS の Safari は Web Bluetooth がないので、Bluefy などの対応したブラウザで使う。
//
// タイマーは状態が変わるたびに知らせを送る（サービス 0xFFF0・知らせ 0xFFF5）。知らせは 0xFE で始まり、4 バイト目が状態、
// 止まった（STOPPED）ときは続く 4 バイトにタイム（分・秒・ミリ秒 2 バイト）、最後の 2 バイトが CRC-16/CCITT（0xFFFF から）。
// Bluetooth の知らせは数十 ms 遅れて揺れるので、届いた時刻をそのまま開始にしない: 止めたときにタイマーが送るタイム（ms 単位で正確）から、
// 開始 = 停止の知らせが届いた時刻 − タイム と逆算する（届く遅れが開始・停止で同じくらいなら打ち消し合う）。
// 時刻はすべて performance.now()（カメラのフレームの captureTime と同じ時間軸）
import { createStore } from "./store";

export const GAN_SERVICE = "0000fff0-0000-1000-8000-00805f9b34fb";
export const GAN_STATE_CHAR = "0000fff5-0000-1000-8000-00805f9b34fb";

export enum PadState {
  DISCONNECT = 0,
  GET_SET = 1, // 手を置いて準備ができた（緑）
  HANDS_OFF = 2, // 準備の前に手を離した
  RUNNING = 3, // 計測中
  STOPPED = 4, // 止まった（タイムつき）
  IDLE = 5, // リセットした
  HANDS_ON = 6, // 手を置いた（まだ準備中）
  FINISHED = 7, // 止めた後に手を離した
}

export interface PadEvent {
  state: PadState;
  timeMs?: number; // STOPPED のときのタイム
}

export function crc16ccitt(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

// 知らせの中身を読む。形が違う・CRC が合わなければ null
export function parsePadEvent(data: DataView): PadEvent | null {
  if (data.byteLength < 6 || data.getUint8(0) !== 0xfe) return null;
  const body = new Uint8Array(data.buffer, data.byteOffset + 2, data.byteLength - 4);
  if (crc16ccitt(body) !== data.getUint16(data.byteLength - 2, true)) return null;
  const state = data.getUint8(3) as PadState;
  if (state === PadState.STOPPED) {
    if (data.byteLength < 10) return null;
    return { state, timeMs: data.getUint8(4) * 60000 + data.getUint8(5) * 1000 + data.getUint16(6, true) };
  }
  return { state };
}

export type PadStatus = "unsupported" | "disconnected" | "connecting" | "connected";

export interface PadInfo {
  status: PadStatus;
  name: string;
  state: PadState | null;
  message: string | null;
}

interface BtCharacteristic extends EventTarget {
  value?: DataView;
  startNotifications(): Promise<unknown>;
}
interface BtDevice extends EventTarget {
  name?: string;
  gatt?: { connected: boolean; connect(): Promise<{ getPrimaryService(s: string): Promise<{ getCharacteristic(c: string): Promise<BtCharacteristic> }> }>; disconnect(): void };
}
interface Bt {
  requestDevice(o: unknown): Promise<BtDevice>;
  getDevices?(): Promise<BtDevice[]>;
}
const bluetooth = (): Bt | undefined => (typeof navigator !== "undefined" ? (navigator as unknown as { bluetooth?: Bt }).bluetooth : undefined);

export const padStore = createStore<PadInfo>({ status: bluetooth() ? "disconnected" : "unsupported", name: "", state: null, message: null });

type Listener = (e: PadEvent, at: number) => void;
const listeners = new Set<Listener>();
export function onPadEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let device: BtDevice | null = null;
const LAST_KEY = "cubevision.ganTimer";

function emit(e: PadEvent, at: number): void {
  padStore.set({ state: e.state });
  for (const fn of listeners) fn(e, at);
}

async function attach(dev: BtDevice): Promise<void> {
  device = dev;
  padStore.set({ status: "connecting", name: dev.name ?? "GAN タイマー", message: null });
  const server = await dev.gatt?.connect();
  if (!server) throw new Error("つなげませんでした");
  const ch = await (await server.getPrimaryService(GAN_SERVICE)).getCharacteristic(GAN_STATE_CHAR);
  ch.addEventListener("characteristicvaluechanged", () => {
    const at = performance.now();
    const e = ch.value && parsePadEvent(ch.value);
    if (e) emit(e, at);
  });
  dev.addEventListener("gattserverdisconnected", () => {
    if (device !== dev) return;
    padStore.set({ status: "disconnected", state: null, message: "タイマーとの接続が切れました" });
    emit({ state: PadState.DISCONNECT }, performance.now());
  });
  await ch.startNotifications();
  padStore.set({ status: "connected", message: null });
  try {
    localStorage.setItem(LAST_KEY, "1");
  } catch {}
}

// 「タイマーをつなぐ」ボタンから（Bluetooth の選択はボタンを押した操作の中でしか開けない）
export async function connectPad(): Promise<void> {
  const bt = bluetooth();
  if (!bt) {
    padStore.set({ status: "unsupported", message: "このブラウザは Bluetooth に対応していません（iPhone は Bluefy などを使ってください）" });
    return;
  }
  try {
    const dev = await bt.requestDevice({ filters: [{ namePrefix: "GAN" }, { namePrefix: "Gan" }, { namePrefix: "gan" }], optionalServices: [GAN_SERVICE] });
    await attach(dev);
  } catch (e) {
    padStore.set({ status: "disconnected", message: (e as Error).name === "NotFoundError" ? null : `つなげませんでした: ${(e as Error).message}` });
  }
}

export function disconnectPad(): void {
  const dev = device;
  device = null;
  dev?.gatt?.disconnect();
  padStore.set({ status: bluetooth() ? "disconnected" : "unsupported", state: null, message: null });
  try {
    localStorage.removeItem(LAST_KEY);
  } catch {}
}

// 前につないだタイマーに、ボタンを押さずにつなぎ直す（ブラウザが許可済みの機器の一覧 getDevices に対応しているときだけ）
export async function reconnectPad(): Promise<void> {
  const bt = bluetooth();
  try {
    if (!bt?.getDevices || !localStorage.getItem(LAST_KEY)) return;
    const dev = (await bt.getDevices()).find((d) => /^gan/i.test(d.name ?? ""));
    if (dev) await attach(dev);
  } catch {
    padStore.set({ status: "disconnected" });
  }
}

export const padConnected = () => padStore.get().status === "connected";

// 開発用: 偽のタイマー（E2E・デモで知らせを流す）
export function fakePadEvent(e: PadEvent, at = performance.now()): void {
  emit(e, at);
}
export function fakePadConnect(): void {
  padStore.set({ status: "connected", name: "偽の GAN タイマー", message: null });
}

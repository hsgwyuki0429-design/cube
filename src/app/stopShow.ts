// 止めた後の画面（src/ui/StoppedScreen.tsx）に見せる、精密解析の Worker からの知らせ（src/vision/showFeed.ts）を受けて持つ。
// 送り先は BroadcastChannel（ページごとに 1 つの名前）。解析ごとの番号（token）が違う知らせは捨てる。DOM を使わない
import type { ReadShow, SearchShow, ShowMessage, ShowRef } from "../vision/showProtocol";
import { createStore } from "./store";

// 録画を読んだ量: 知らせ 1 つ分（前の知らせからの、直接読めたマスの合計と枚数・時刻の範囲）
export interface ReadChunk {
  t0: number;
  t1: number;
  sum: number;
  n: number;
}

export interface ShowState {
  token: number;
  read: ReadShow | null; // いちばん新しい読み
  chunks: ReadChunk[];
  search: SearchShow | null;
  received: number; // 受けた知らせの数（調べるとき用）
}

export const showStore = createStore<ShowState>({ token: 0, read: null, chunks: [], search: null, received: 0 });

const CHANNEL = `cubevision-show-${Math.random().toString(36).slice(2)}`;
let bc: BroadcastChannel | null = null;
let nextToken = 1;

export function onShowMessage(m: ShowMessage): void {
  const s = showStore.get();
  if (m.token !== s.token) return;
  if (m.kind === "read") {
    const chunks = m.n > 0 ? [...s.chunks, { t0: m.t0, t1: m.t1, sum: m.sum, n: m.n }] : s.chunks;
    showStore.set({ read: m, chunks, received: s.received + 1 });
  } else showStore.set({ search: m, received: s.received + 1 });
}

// 新しい解析を始める: 送り先と番号（RefineInput.show）。前の解析の知らせは捨てる
export function beginShow(): ShowRef | undefined {
  const token = nextToken++;
  showStore.set({ token, read: null, chunks: [], search: null, received: 0 });
  if (typeof BroadcastChannel === "undefined") return undefined;
  if (!bc) {
    try {
      bc = new BroadcastChannel(CHANNEL);
      bc.onmessage = (e: MessageEvent<ShowMessage>) => onShowMessage(e.data);
    } catch {
      return undefined;
    }
  }
  return { channel: CHANNEL, token };
}

// 区間ごとの読めた量（1 フレームあたりの直接読めたマス）: [from, to] を n に分けて
export function readBins(chunks: readonly ReadChunk[], from: number, to: number, n: number): (number | null)[] {
  const sum = new Array<number>(n).fill(0);
  const cnt = new Array<number>(n).fill(0);
  const span = Math.max(1, to - from);
  for (const c of chunks) {
    const mid = (c.t0 + c.t1) / 2;
    if (mid < from || mid > to) continue;
    const i = Math.min(n - 1, Math.floor(((mid - from) / span) * n));
    sum[i] += c.sum;
    cnt[i] += c.n;
  }
  return sum.map((v, i) => (cnt[i] ? v / cnt[i] : null));
}

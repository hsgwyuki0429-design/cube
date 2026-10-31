// CPU プロファイル（node:inspector）と、関数ごとの時間のまとめ（デバッグ用テストで使う）
import { Session } from "node:inspector";

export interface ProfNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  hitCount: number;
  children?: number[];
}

export async function profile<T>(f: () => T): Promise<{ value: T; nodes: ProfNode[]; interval: number }> {
  const s = new Session();
  s.connect();
  const post = (m: string, p?: object) => new Promise<unknown>((res, rej) => s.post(m, p ?? {}, (e, r) => (e ? rej(e) : res(r))));
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval: 500 });
  await post("Profiler.start");
  const value = f();
  const { profile: p } = (await post("Profiler.stop")) as { profile: { nodes: ProfNode[]; startTime: number; endTime: number; samples: number[] } };
  s.disconnect();
  return { value, nodes: p.nodes, interval: (p.endTime - p.startTime) / 1000 / p.samples.length };
}

// 関数ごとの自分の時間と、呼んだ先を含めた時間（再帰は 1 回だけ数える）
export function summarize(nodes: ProfNode[], interval: number, frames: number, top: number): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const key = (n: ProfNode) => `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").slice(-2).join("/")}:${n.callFrame.lineNumber + 1}`;
  const self = new Map<string, number>();
  const total = new Map<string, number>();
  const walk = (id: number, stack: Set<string>): number => {
    const n = byId.get(id)!;
    const k = key(n);
    let sum = n.hitCount;
    for (const c of n.children ?? []) sum += walk(c, new Set([...stack, k]));
    self.set(k, (self.get(k) ?? 0) + n.hitCount);
    if (!stack.has(k)) total.set(k, (total.get(k) ?? 0) + sum);
    return sum;
  };
  walk(nodes[0].id, new Set());
  const ms = (h: number) => ((h * interval) / frames).toFixed(1).padStart(6);
  const rows = (m: Map<string, number>) =>
    [...m.entries()]
      .filter(([k]) => !k.startsWith("(root)") && !k.startsWith("(program)") && !k.startsWith("(idle)"))
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([k, v]) => `${ms(v)}ms  ${k}`)
      .join("\n");
  return `--- 呼んだ先を含めた時間（1 フレームあたり）\n${rows(total)}\n--- 自分の時間\n${rows(self)}`;
}


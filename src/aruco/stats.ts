// 検出結果の集計（純粋な計算。Node でも動く）。
// 写したシートの各マーカー（ID × 大きさ = スロット）について、見えていた区間での検出率・最長の途切れ・
// 動きの速さ別の検出率を出し、方式 × 色 × 大きさの表にまとめる。
import type { Marker } from "./detect";
import { COLOR_LABEL, COLOR_ORDER, type ColorKey, FACE_COLORS, type SheetSpec, classifyColor, markerLabel, stickerOf } from "./stickers";

export interface FrameRecord {
  t: number; // 動画の時刻（ms、最初のフレームが 0）
  results: { markers: Marker[]; ms: number }[]; // 方式ごと
}

export interface StatsInput {
  frames: FrameRecord[];
  configs: string[];
  sheet: SheetSpec;
  width: number; // 解析した画像の大きさ
  height: number;
  timeScale: number; // 実際の時間 = 動画の時刻 × timeScale（スロー再生用に書き出された動画のとき < 1）
}

// 速さの区切り（マス/秒。マス = マーカーの 1 セル = 辺の 1/6）。
// 56mm のキューブを 10 手/秒で回すと、ステッカーは 150〜200 マス/秒ほどで動く
export const SPEED_EDGES = [0, 10, 50, 150, 400, Number.POSITIVE_INFINITY];

export interface SlotStat {
  config: number;
  id: number;
  size: number;
  name: string; // U0 など（ステッカー以外は #90）
  color: ColorKey | null;
  colorFromSpec: boolean;
  rgb: [number, number, number] | null;
  frames: number; // 解析したフレーム数
  inRange: number; // 見えていたはずのフレーム（最初と最後の検出の間。途中で画面の外に出たフレームも数える）
  hits: number;
  rateRange: number; // hits / inRange
  rateAll: number; // hits / frames
  longestGap: number; // 区間内で続けて読めなかったフレーム数
  longestGapMs: number; // その間、読めた直前から直後まで（実時間）
  pxPerCell: number; // マーカーの 1 セルの画素数（中央値）
  contrastGray: number;
  contrastMax: number;
  speed: { n: number; hits: number }[]; // SPEED_EDGES の区間ごと
  track: Uint8Array; // フレームごと: 0 区間外 / 1 読めない / 2 読めた
}

export interface GroupStat {
  config: number;
  color: ColorKey | null;
  size: number;
  slots: number;
  inRange: number;
  hits: number;
  rate: number;
  worstRate: number;
  longestGapMs: number;
  pxPerCell: number;
  contrastGray: number;
  contrastMax: number;
}

export interface ConfigStat {
  name: string;
  msMean: number;
  msP95: number;
  unexpected: number; // シートにない ID の検出（誤検出）
  unexpectedFrames: number;
  speed: { n: number; hits: number }[];
  inRange: number;
  hits: number;
}

export interface Summary {
  frames: number;
  durationMs: number; // 実時間
  fps: number; // 実際の撮影 fps（推定）
  configs: ConfigStat[];
  slots: SlotStat[];
  groups: GroupStat[];
  slotOf: Int16Array[][]; // [方式][フレーム] → マーカーごとのスロット番号（slots の添字、-1 は割り当てなし）
}

interface Hit {
  x: number;
  y: number;
  side: number;
  m: Marker;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
};

const center = (m: Marker): [number, number] => {
  const c = m.corners;
  return [(c[0] + c[2] + c[4] + c[6]) / 4, (c[1] + c[3] + c[5] + c[7]) / 4];
};

export function summarize(input: StatsInput): Summary {
  const { frames, sheet } = input;
  const n = frames.length;
  const realT = frames.map((f) => f.t * input.timeScale);
  const dts: number[] = [];
  for (let i = 1; i < n; i++) dts.push(realT[i] - realT[i - 1]);
  const dt = median(dts) || 1000 / 30;
  const slots: SlotStat[] = [];
  const configs: ConfigStat[] = [];
  const slotOf: Int16Array[][] = [];

  input.configs.forEach((name, ci) => {
    const base = slots.length;
    const { hitsBySlot, assign, unexpected, unexpectedFrames } = assignSlots(input, ci);
    slotOf.push(assign.map((a) => a.map((s) => (s < 0 ? -1 : base + s))));
    const cfgSpeed = SPEED_EDGES.slice(1).map(() => ({ n: 0, hits: 0 }));
    let cfgIn = 0;
    let cfgHits = 0;
    let k = 0;
    for (const id of sheet.ids) {
      for (const size of sheet.sizes) {
        const st = slotStat(realT, ci, id, size, hitsBySlot[k++], sheet.scheme);
        st.speed.forEach((b, i) => {
          cfgSpeed[i].n += b.n;
          cfgSpeed[i].hits += b.hits;
        });
        cfgIn += st.inRange;
        cfgHits += st.hits;
        slots.push(st);
      }
    }
    const ms = frames.map((f) => f.results[ci]?.ms ?? 0);
    const sorted = [...ms].sort((a, b) => a - b);
    configs.push({
      name,
      msMean: ms.reduce((a, b) => a + b, 0) / Math.max(1, ms.length),
      msP95: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0,
      unexpected,
      unexpectedFrames,
      speed: cfgSpeed,
      inRange: cfgIn,
      hits: cfgHits,
    });
  });
  measuredColors(slots);

  return {
    frames: n,
    durationMs: n ? realT[n - 1] - realT[0] + dt : 0,
    fps: 1000 / dt,
    configs,
    slots,
    groups: groupStats(slots),
    slotOf,
  };
}

// フレームごとに、検出したマーカーをスロット（ID × 大きさ）に割り当てる。
// 同じ ID が複数の大きさで載っているときは、辺の長さ（その時点の 1mm の画素数で割る）と直前の位置で決める
function assignSlots(input: StatsInput, ci: number) {
  const { frames, sheet } = input;
  const sizes = sheet.sizes;
  const k = sizes.length;
  const idIndex = new Map(sheet.ids.map((id, i) => [id, i]));
  const nSlots = sheet.ids.length * k;
  const hitsBySlot: (Hit | null)[][] = Array.from({ length: nSlots }, () => new Array(frames.length).fill(null));
  const assign: Int16Array[] = [];
  let unexpected = 0;
  let unexpectedFrames = 0;

  // 1mm の画素数: ある ID の全部の大きさが写ったフレームで、辺の長さを大きさで割った中央値
  const scale: (number | null)[] = frames.map((f) => {
    if (k < 2) return null;
    const byId = new Map<number, number[]>();
    for (const m of f.results[ci]?.markers ?? []) {
      if (!idIndex.has(m.id)) continue;
      const a = byId.get(m.id) ?? [];
      a.push(m.side);
      byId.set(m.id, a);
    }
    const est: number[] = [];
    for (const sides of byId.values()) {
      if (sides.length !== k) continue;
      sides.sort((a, b) => a - b);
      sides.forEach((s, i) => est.push(s / sizes[i]));
    }
    return est.length ? median(est) : null;
  });
  fillNearest(scale);

  const last: ({ x: number; y: number; side: number; f: number } | null)[] = new Array(nSlots).fill(null);
  frames.forEach((f, fi) => {
    const markers = f.results[ci]?.markers ?? [];
    const out = new Int16Array(markers.length).fill(-1);
    const byId = new Map<number, number[]>();
    let bad = 0;
    markers.forEach((m, mi) => {
      if (!idIndex.has(m.id)) {
        bad++;
        return;
      }
      const a = byId.get(m.id) ?? [];
      a.push(mi);
      byId.set(m.id, a);
    });
    unexpected += bad;
    if (bad) unexpectedFrames++;
    for (const [id, mis] of byId) {
      const slot0 = idIndex.get(id)! * k;
      let pairs: [number, number][]; // [マーカー, 大きさの添字]
      if (mis.length === k) {
        const order = [...mis].sort((a, b) => markers[a].side - markers[b].side);
        pairs = order.map((mi, si) => [mi, si]);
      } else {
        const s = scale[fi] ?? bestScale(mis.map((mi) => markers[mi].side), sizes);
        const cands: { mi: number; si: number; cost: number }[] = [];
        for (const mi of mis) {
          const m = markers[mi];
          const [x, y] = center(m);
          for (let si = 0; si < k; si++) {
            let cost = k > 1 ? Math.abs(Math.log(m.side / (s * sizes[si]))) : 0;
            const l = last[slot0 + si];
            if (l && fi - l.f <= 30) cost += (0.5 * Math.hypot(x - l.x, y - l.y)) / Math.max(1, l.side);
            cands.push({ mi, si, cost });
          }
        }
        cands.sort((a, b) => a.cost - b.cost);
        const usedM = new Set<number>();
        const usedS = new Set<number>();
        pairs = [];
        for (const c of cands) {
          if (usedM.has(c.mi) || usedS.has(c.si)) continue;
          usedM.add(c.mi);
          usedS.add(c.si);
          pairs.push([c.mi, c.si]);
        }
      }
      for (const [mi, si] of pairs) {
        const m = markers[mi];
        const [x, y] = center(m);
        hitsBySlot[slot0 + si][fi] = { x, y, side: m.side, m };
        last[slot0 + si] = { x, y, side: m.side, f: fi };
        out[mi] = slot0 + si;
      }
    }
    assign.push(out);
  });
  return { hitsBySlot, assign, unexpected, unexpectedFrames };
}

// 決まらなかったフレームは、前後で決まったフレームのうち近い方の値
function fillNearest(xs: (number | null)[]): void {
  const prev: (number | null)[] = [];
  let p: number | null = null;
  let pi = -1;
  const prevIdx: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] !== null) {
      p = xs[i];
      pi = i;
    }
    prev.push(p);
    prevIdx.push(pi);
  }
  let q: number | null = null;
  let qi = -1;
  for (let i = xs.length - 1; i >= 0; i--) {
    if (xs[i] !== null) {
      q = xs[i];
      qi = i;
      continue;
    }
    if (prev[i] === null) xs[i] = q;
    else if (q === null) xs[i] = prev[i];
    else xs[i] = i - prevIdx[i] <= qi - i ? prev[i] : q;
  }
}

// 1mm の画素数が分からないとき: 辺の長さが大きさの候補に最もよく合う値
function bestScale(sides: number[], sizes: number[]): number {
  let best = sides[0] / sizes[sizes.length - 1];
  let bestCost = Number.POSITIVE_INFINITY;
  for (const s0 of sides) {
    for (const z of sizes) {
      const s = s0 / z;
      let cost = 0;
      for (const side of sides) cost += Math.min(...sizes.map((zz) => Math.abs(Math.log(side / (s * zz)))));
      // 同点なら大きい方の大きさ（よく写る方）とみなす
      if (cost < bestCost - 1e-9) {
        bestCost = cost;
        best = s;
      }
    }
  }
  return best;
}

function slotStat(realT: number[], ci: number, id: number, size: number, hits: (Hit | null)[], scheme: SheetSpec["scheme"]): SlotStat {
  const n = hits.length;
  const track = new Uint8Array(n);
  // 仕様で色が決まる ID（54 種類の 0〜53、12 種類の全部）。テストページの 90〜92 は写った色で決める
  const spec = scheme === "aruco12" ? (id >= 0 && id < 12 ? { color: FACE_COLORS[id % 6] } : null) : stickerOf(id);
  const speed = SPEED_EDGES.slice(1).map(() => ({ n: 0, hits: 0 }));
  const idx: number[] = [];
  hits.forEach((h, i) => h && idx.push(i));
  const st: SlotStat = {
    config: ci,
    id,
    size,
    name: markerLabel(scheme, id),
    color: spec?.color ?? null,
    colorFromSpec: !!spec,
    rgb: null,
    frames: n,
    inRange: 0,
    hits: idx.length,
    rateRange: 0,
    rateAll: n ? idx.length / n : 0,
    longestGap: 0,
    longestGapMs: 0,
    pxPerCell: 0,
    contrastGray: 0,
    contrastMax: 0,
    speed,
    track,
  };
  if (!idx.length) return st;
  const hs = idx.map((i) => hits[i]!);
  st.rgb = [0, 1, 2].map((c) => Math.round(median(hs.map((h) => h.m.rgb[c])))) as [number, number, number];
  st.pxPerCell = median(hs.map((h) => h.side)) / 6;
  st.contrastGray = median(hs.map((h) => h.m.contrastGray));
  st.contrastMax = median(hs.map((h) => h.m.contrastMax));

  const binOf = (v: number) => {
    for (let b = 0; b < SPEED_EDGES.length - 1; b++) if (v < SPEED_EDGES[b + 1]) return b;
    return SPEED_EDGES.length - 2;
  };
  // 速さ（マス/秒）: 前後の検出の間の移動。検出したフレームは前後の検出の中心差分
  const speedBetween = (a: number, b: number) => {
    const A = hits[a]!;
    const B = hits[b]!;
    const ms = realT[b] - realT[a];
    if (ms <= 0) return 0;
    const cell = (A.side + B.side) / 12;
    return (Math.hypot(B.x - A.x, B.y - A.y) / cell / ms) * 1000;
  };

  for (let j = 0; j < idx.length; j++) {
    const i = idx[j];
    track[i] = 2;
    st.inRange++;
    const a = idx[Math.max(0, j - 1)];
    const b = idx[Math.min(idx.length - 1, j + 1)];
    const v = a === b ? 0 : speedBetween(a, b);
    speed[binOf(v)].n++;
    speed[binOf(v)].hits++;
    if (j === idx.length - 1) break;
    // 次の検出までの読めなかったフレーム
    const next = idx[j + 1];
    if (next === i + 1) continue;
    const v2 = speedBetween(i, next);
    const missed = next - i - 1;
    for (let f = i + 1; f < next; f++) {
      track[f] = 1;
      st.inRange++;
      speed[binOf(v2)].n++;
    }
    if (missed > st.longestGap) {
      st.longestGap = missed;
      st.longestGapMs = realT[next] - realT[i];
    }
  }
  st.rateRange = st.inRange ? st.hits / st.inRange : 0;
  return st;
}

// 仕様で色が決まらないマーカー（テストページ）は、全方式の検出の色で決める（ある方式で読めなくても同じ色の行に入る）
function measuredColors(slots: SlotStat[]): void {
  const bySlot = new Map<string, SlotStat[]>();
  for (const s of slots) {
    if (s.colorFromSpec) continue;
    const key = `${s.id}|${s.size}`;
    const a = bySlot.get(key) ?? [];
    a.push(s);
    bySlot.set(key, a);
  }
  for (const ss of bySlot.values()) {
    const seen = ss.filter((s) => s.rgb);
    if (!seen.length) continue;
    const rgb = [0, 1, 2].map((c) => Math.round(median(seen.map((s) => s.rgb![c])))) as [number, number, number];
    const color = classifyColor(rgb);
    for (const s of ss) {
      s.color = color;
      s.rgb ??= rgb;
    }
  }
}

function groupStats(slots: SlotStat[]): GroupStat[] {
  const map = new Map<string, SlotStat[]>();
  for (const s of slots) {
    const key = `${s.config}|${s.color}|${s.size}`;
    const a = map.get(key) ?? [];
    a.push(s);
    map.set(key, a);
  }
  const out: GroupStat[] = [];
  for (const ss of map.values()) {
    const seen = ss.filter((s) => s.inRange > 0);
    const inRange = ss.reduce((a, s) => a + s.inRange, 0);
    const hits = ss.reduce((a, s) => a + s.hits, 0);
    out.push({
      config: ss[0].config,
      color: ss[0].color,
      size: ss[0].size,
      slots: ss.length,
      inRange,
      hits,
      rate: inRange ? hits / inRange : 0,
      worstRate: seen.length ? Math.min(...seen.map((s) => s.rateRange)) : 0,
      longestGapMs: Math.max(0, ...ss.map((s) => s.longestGapMs)),
      pxPerCell: median(seen.map((s) => s.pxPerCell)),
      contrastGray: median(seen.map((s) => s.contrastGray)),
      contrastMax: median(seen.map((s) => s.contrastMax)),
    });
  }
  const colorRank = (c: ColorKey | null) => (c ? COLOR_ORDER.indexOf(c) : 99);
  return out.sort((a, b) => a.config - b.config || colorRank(a.color) - colorRank(b.color) || a.size - b.size);
}

// ---- 書き出し ----

const pct = (v: number) => `${(v * 100).toFixed(1)}`;
const speedLabel = (i: number) => (SPEED_EDGES[i + 1] === Number.POSITIVE_INFINITY ? `${SPEED_EDGES[i]}+` : `${SPEED_EDGES[i]}-${SPEED_EDGES[i + 1]}`);
export const SPEED_LABELS = SPEED_EDGES.slice(1).map((_, i) => speedLabel(i));
export const colorLabel = (c: ColorKey | null) => (c ? COLOR_LABEL[c] : "?");

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(sum: Summary, meta: Record<string, string | number> = {}): string {
  const head = [
    "方式",
    "ID",
    "ステッカー",
    "大きさmm",
    "色",
    "色の出どころ",
    "実測RGB",
    "解析フレーム",
    "区間フレーム",
    "検出フレーム",
    "区間検出率%",
    "全体検出率%",
    "最長途切れフレーム",
    "最長途切れms",
    "px/マス",
    "コントラスト_グレー",
    "コントラスト_max",
    ...SPEED_LABELS.map((l) => `速さ${l}マス毎秒_検出率%`),
    ...SPEED_LABELS.map((l) => `速さ${l}マス毎秒_フレーム`),
  ];
  const rows = sum.slots.map((s) => [
    sum.configs[s.config].name,
    s.id,
    s.name,
    s.size,
    colorLabel(s.color),
    s.colorFromSpec ? "仕様" : "実測",
    s.rgb ? s.rgb.join(" ") : "",
    s.frames,
    s.inRange,
    s.hits,
    pct(s.rateRange),
    pct(s.rateAll),
    s.longestGap,
    s.longestGapMs.toFixed(1),
    s.pxPerCell.toFixed(1),
    s.contrastGray,
    s.contrastMax,
    ...s.speed.map((b) => (b.n ? pct(b.hits / b.n) : "")),
    ...s.speed.map((b) => b.n),
  ]);
  const metaLines = Object.entries(meta).map(([k, v]) => `# ${k}: ${v}`);
  return [...metaLines, head, ...rows].map((r) => (Array.isArray(r) ? r.map(csvCell).join(",") : r)).join("\n") + "\n";
}

export function toMarkdown(sum: Summary, sheet: SheetSpec, meta: Record<string, string | number> = {}): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(meta)) lines.push(`- ${k}: ${v}`);
  lines.push(`- 解析フレーム: ${sum.frames}（実時間 ${(sum.durationMs / 1000).toFixed(2)} 秒、${sum.fps.toFixed(0)} fps 相当）`, "");

  const colors = [...new Set(sum.groups.map((g) => g.color))];
  for (let ci = 0; ci < sum.configs.length; ci++) {
    const c = sum.configs[ci];
    lines.push(`### ${c.name}`, "");
    lines.push(`区間検出率（%）。括弧内は最も低かったマーカー、px/マス、コントラスト（グレー / max）`, "");
    lines.push(`| 色 | ${sheet.sizes.map((z) => `${z}mm`).join(" | ")} |`, `|---|${sheet.sizes.map(() => "---").join("|")}|`);
    for (const color of colors) {
      const cells = sheet.sizes.map((z) => {
        const g = sum.groups.find((x) => x.config === ci && x.color === color && x.size === z);
        if (!g || !g.inRange) return "—";
        return `${pct(g.rate)}（${pct(g.worstRate)}, ${g.pxPerCell.toFixed(1)}px, ${g.contrastGray}/${g.contrastMax}）`;
      });
      lines.push(`| ${colorLabel(color)} | ${cells.join(" | ")} |`);
    }
    lines.push("");
  }
  lines.push("### 方式の比較", "");
  lines.push(`| 方式 | 全体の区間検出率 | 処理時間 平均 / 95% (ms) | 誤検出（シートにない ID） |`, `|---|---|---|---|`);
  for (const c of sum.configs) {
    lines.push(`| ${c.name} | ${c.inRange ? pct(c.hits / c.inRange) : "—"}% | ${c.msMean.toFixed(1)} / ${c.msP95.toFixed(1)} | ${c.unexpected}（${c.unexpectedFrames} フレーム） |`);
  }
  lines.push("", "### 動きの速さ別の検出率（マス/秒）", "");
  lines.push(`| 方式 | ${SPEED_LABELS.join(" | ")} |`, `|---|${SPEED_LABELS.map(() => "---").join("|")}|`);
  for (const c of sum.configs) {
    lines.push(`| ${c.name} | ${c.speed.map((b) => (b.n ? `${pct(b.hits / b.n)}%（${b.n}）` : "—")).join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

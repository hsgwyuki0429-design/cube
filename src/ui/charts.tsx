// データ画面のグラフ（SVG）。選べる 4 種類: タイムの推移・CFOP の内訳・タイムの分布・TPS の推移。
// 色は役割で決める（1 本だけのグラフは 1 色目。推移の ao5・ao12 は 2・3 色目）。文字は文字の色（系列の色を使わない）。
// 触れた所（マウス・指）の値を出す
import { useEffect, useRef, useState } from "preact/hooks";
import { type Solve, effectiveTime, formatTime } from "../app/storage";

export type ChartKind = "timeline" | "splits" | "histogram" | "tps";
export const CHART_KINDS: [ChartKind, string][] = [
  ["timeline", "タイムの推移"],
  ["splits", "CFOP の内訳"],
  ["histogram", "タイムの分布"],
  ["tps", "TPS の推移"],
];

const H = 150;
const PAD = { l: 34, r: 30, t: 8, b: 20 };

function useWidth(): [preact.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// 目盛り: 0 からでなくてよい範囲（タイムの推移）の、きりのよい値
function ticks(lo: number, hi: number, n = 3): number[] {
  const span = Math.max(1e-9, hi - lo);
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

// 直近 n 回の WCA 方式の平均（最良と最悪を除く）。DNF が 2 つ以上なら Infinity
function rolling(times: number[], n: number): (number | null)[] {
  return times.map((_, i) => {
    if (i + 1 < n) return null;
    const w = times.slice(i + 1 - n, i + 1).sort((a, b) => a - b);
    const kept = w.slice(1, -1);
    return kept.some((t) => !Number.isFinite(t)) ? null : kept.reduce((a, b) => a + b, 0) / kept.length;
  });
}

interface Tip {
  x: number;
  y: number;
  lines: string[];
}

function Frame({ width, children, tip, onMove, onLeave, label }: { width: number; children: preact.ComponentChildren; tip: Tip | null; onMove?: (x: number, y: number) => void; onLeave?: () => void; label: string }) {
  const move = (e: PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    onMove?.(e.clientX - r.left, e.clientY - r.top);
  };
  return (
    <div class="viz-frame">
      <svg width={width} height={H} role="img" aria-label={label} onPointerMove={move} onPointerDown={move} onPointerLeave={onLeave}>
        {children}
      </svg>
      {tip && (
        <div class="viz-tip" style={{ left: Math.min(Math.max(tip.x, 50), width - 50), top: Math.max(0, tip.y - 8) }}>
          {tip.lines.map((l, i) => (
            <div key={i} class={i ? "" : "b"}>
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const sec = (ms: number) => ms / 1000;

function Empty({ text }: { text: string }) {
  return <div class="viz-empty">{text}</div>;
}

// タイムの推移: 各回の点と ao5・ao12 の線（古い → 新しい。直近 100 回）
function Timeline({ solves, width }: { solves: Solve[]; width: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const list = solves.slice(0, 100).reverse();
  const times = list.map(effectiveTime);
  const valid = times.filter(Number.isFinite);
  if (valid.length < 2) return <Empty text="記録が 2 回以上たまると表示します" />;
  const ao5 = rolling(times, 5);
  const ao12 = rolling(times, 12);
  const lo = Math.min(...valid);
  const hi = Math.max(...valid);
  const pad = (hi - lo) * 0.08 || 500;
  const y0 = Math.max(0, lo - pad);
  const y1 = hi + pad;
  const iw = width - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const X = (i: number) => PAD.l + (list.length === 1 ? iw / 2 : (i / (list.length - 1)) * iw);
  const Y = (v: number) => PAD.t + ih - ((v - y0) / (y1 - y0)) * ih;
  const path = (arr: (number | null)[]) =>
    arr
      .map((v, i) => (v === null ? null : `${X(i).toFixed(1)},${Y(v).toFixed(1)}`))
      .reduce<string[]>((acc, p, i, a) => (p === null ? acc : [...acc, `${i && a[i - 1] !== null ? "L" : "M"}${p}`]), [])
      .join("");
  const lastIdx = (arr: (number | null)[]) => arr.reduce<number>((k, v, i) => (v !== null ? i : k), -1);
  const tip: Tip | null =
    hover === null
      ? null
      : {
          x: X(hover),
          y: Number.isFinite(times[hover]) ? Y(times[hover]) : PAD.t,
          lines: [`#${solves.length - list.length + hover + 1}  ${formatTime(times[hover])}`, ...(ao5[hover] !== null ? [`ao5 ${formatTime(ao5[hover])}`] : []), ...(ao12[hover] !== null ? [`ao12 ${formatTime(ao12[hover])}`] : [])],
        };
  const l5 = lastIdx(ao5);
  const l12 = lastIdx(ao12);
  return (
    <>
      <Frame
        width={width}
        tip={tip}
        label="タイムの推移"
        onMove={(x) => setHover(Math.max(0, Math.min(list.length - 1, Math.round(((x - PAD.l) / iw) * (list.length - 1)))))}
        onLeave={() => setHover(null)}
      >
        {ticks(sec(y0), sec(y1)).map((v) => (
          <g key={v}>
            <line class="viz-grid" x1={PAD.l} x2={width - PAD.r} y1={Y(v * 1000)} y2={Y(v * 1000)} />
            <text class="viz-axis" x={PAD.l - 4} y={Y(v * 1000) + 3} text-anchor="end">
              {v}
            </text>
          </g>
        ))}
        {hover !== null && <line class="viz-cross" x1={X(hover)} x2={X(hover)} y1={PAD.t} y2={PAD.t + ih} />}
        {times.map((t, i) => (Number.isFinite(t) ? <circle key={i} class="viz-dot s1" cx={X(i)} cy={Y(t)} r={hover === i ? 4 : 2.5} /> : null))}
        <path class="viz-line s2" d={path(ao5)} />
        <path class="viz-line s3" d={path(ao12)} />
        {l5 >= 0 && (
          <text class="viz-label" x={X(l5) + 4} y={Y(ao5[l5]!) + 3}>
            ao5
          </text>
        )}
        {l12 >= 0 && (
          <text class="viz-label" x={X(l12) + 4} y={Y(ao12[l12]!) + 12}>
            ao12
          </text>
        )}
      </Frame>
      <div class="viz-legend">
        <span>
          <i class="sw dot s1" />
          各回
        </span>
        <span>
          <i class="sw line s2" />
          ao5
        </span>
        <span>
          <i class="sw line s3" />
          ao12
        </span>
        <span class="muted">秒</span>
      </div>
    </>
  );
}

// CFOP の内訳: 解析で確定した記録の、区間ごとの平均の時間（横棒）
function Splits({ solves, width }: { solves: Solve[]; width: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const names = ["クロス", "F2L", "OLL", "PLL"];
  const sums = names.map(() => ({ t: 0, moves: 0 }));
  let n = 0;
  for (const s of solves) {
    if (!s.splits || s.splits.length !== 4 || s.penalty === "DNF") continue;
    n++;
    s.splits.forEach((x, i) => {
      const prev = i ? s.splits![i - 1] : { t: 0, moves: 0 };
      sums[i].t += x.t - prev.t;
      sums[i].moves += x.moves - prev.moves;
    });
  }
  if (!n) return <Empty text="手順の分かった記録がたまると表示します" />;
  const avg = sums.map((x) => ({ t: x.t / n, moves: x.moves / n }));
  const max = Math.max(...avg.map((a) => a.t), 1);
  const lw = 46;
  const vw = 44;
  const iw = width - lw - vw - 6;
  const row = (H - 10) / 4;
  const bh = Math.min(18, row - 8);
  const tip: Tip | null = hover === null ? null : { x: lw + (avg[hover].t / max) * iw, y: 6 + hover * row, lines: [names[hover], `平均 ${formatTime(avg[hover].t)}`, `${avg[hover].moves.toFixed(1)} 手・${n} 回の平均`] };
  return (
    <>
      <Frame width={width} tip={tip} label="CFOP の内訳" onMove={(_, y) => setHover(Math.max(0, Math.min(3, Math.floor((y - 5) / row))))} onLeave={() => setHover(null)}>
        {avg.map((a, i) => {
          const y = 5 + i * row + (row - bh) / 2;
          const w = Math.max(4, (a.t / max) * iw);
          return (
            <g key={i}>
              <text class="viz-axis" x={lw - 6} y={y + bh / 2 + 4} text-anchor="end">
                {names[i]}
              </text>
              <path class={`viz-bar s1${hover === i ? " hot" : ""}`} d={`M${lw},${y}h${w - 4}a4,4 0 0 1 4,4v${bh - 8}a4,4 0 0 1 -4,4h${-(w - 4)}z`} />
              <text class="viz-value" x={lw + w + 5} y={y + bh / 2 + 4}>
                {formatTime(a.t)}
              </text>
            </g>
          );
        })}
      </Frame>
      <div class="viz-legend">
        <span class="muted">手順の分かった {n} 回の平均（秒）</span>
      </div>
    </>
  );
}

// タイムの分布（ヒストグラム）
function Histogram({ solves, width }: { solves: Solve[]; width: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const times = solves.map(effectiveTime).filter(Number.isFinite).map(sec);
  if (times.length < 2) return <Empty text="記録が 2 回以上たまると表示します" />;
  const lo = Math.floor(Math.min(...times));
  const hi = Math.floor(Math.max(...times)) + 1;
  const step = Math.max(1, Math.ceil((hi - lo) / 12));
  const bins = Array.from({ length: Math.ceil((hi - lo) / step) }, (_, i) => ({ from: lo + i * step, n: 0 }));
  for (const t of times) bins[Math.min(bins.length - 1, Math.floor((t - lo) / step))].n++;
  const max = Math.max(...bins.map((b) => b.n));
  const iw = width - PAD.l - 8;
  const ih = H - PAD.t - PAD.b;
  const bw = iw / bins.length;
  const tip: Tip | null = hover === null ? null : { x: PAD.l + (hover + 0.5) * bw, y: PAD.t + ih - (bins[hover].n / max) * ih, lines: [`${bins[hover].from}〜${bins[hover].from + step} 秒`, `${bins[hover].n} 回`] };
  return (
    <>
      <Frame width={width} tip={tip} label="タイムの分布" onMove={(x) => setHover(Math.max(0, Math.min(bins.length - 1, Math.floor((x - PAD.l) / bw))))} onLeave={() => setHover(null)}>
        {ticks(0, max, 2).map((v) => (
          <g key={v}>
            <line class="viz-grid" x1={PAD.l} x2={width - 8} y1={PAD.t + ih - (v / max) * ih} y2={PAD.t + ih - (v / max) * ih} />
            <text class="viz-axis" x={PAD.l - 4} y={PAD.t + ih - (v / max) * ih + 3} text-anchor="end">
              {v}
            </text>
          </g>
        ))}
        {bins.map((b, i) => {
          const h = (b.n / max) * ih;
          const x = PAD.l + i * bw + 1;
          const w = Math.max(1, bw - 2);
          const y = PAD.t + ih - h;
          const r = Math.min(4, w / 2, h);
          return b.n ? <path key={i} class={`viz-bar s1${hover === i ? " hot" : ""}`} d={`M${x},${y + h}v${-(h - r)}a${r},${r} 0 0 1 ${r},${-r}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h - r}z`} /> : null;
        })}
        {[0, bins.length - 1].map((i) => (
          <text key={i} class="viz-axis" x={PAD.l + (i + 0.5) * bw} y={H - 6} text-anchor="middle">
            {bins[i].from}
          </text>
        ))}
      </Frame>
      <div class="viz-legend">
        <span class="muted">横: タイム（秒）・縦: 回数</span>
      </div>
    </>
  );
}

// TPS の推移（1 秒あたりの手数。直近 100 回）
function Tps({ solves, width }: { solves: Solve[]; width: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const list = solves
    .slice(0, 100)
    .reverse()
    .filter((s) => s.moves.length && s.tps > 0);
  if (list.length < 2) return <Empty text="手順の分かった記録が 2 回以上たまると表示します" />;
  const v = list.map((s) => s.tps);
  const lo = Math.max(0, Math.min(...v) - 0.3);
  const hi = Math.max(...v) + 0.3;
  const iw = width - PAD.l - 10;
  const ih = H - PAD.t - PAD.b;
  const X = (i: number) => PAD.l + (i / (list.length - 1)) * iw;
  const Y = (t: number) => PAD.t + ih - ((t - lo) / (hi - lo)) * ih;
  const tip: Tip | null = hover === null ? null : { x: X(hover), y: Y(v[hover]), lines: [`${v[hover].toFixed(2)} TPS`, `${list[hover].moves.length} 手・${formatTime(list[hover].timeMs)}`] };
  return (
    <>
      <Frame width={width} tip={tip} label="TPS の推移" onMove={(x) => setHover(Math.max(0, Math.min(list.length - 1, Math.round(((x - PAD.l) / iw) * (list.length - 1)))))} onLeave={() => setHover(null)}>
        {ticks(lo, hi).map((t) => (
          <g key={t}>
            <line class="viz-grid" x1={PAD.l} x2={width - 10} y1={Y(t)} y2={Y(t)} />
            <text class="viz-axis" x={PAD.l - 4} y={Y(t) + 3} text-anchor="end">
              {t}
            </text>
          </g>
        ))}
        {hover !== null && <line class="viz-cross" x1={X(hover)} x2={X(hover)} y1={PAD.t} y2={PAD.t + ih} />}
        <path class="viz-line s1" d={v.map((t, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(t).toFixed(1)}`).join("")} />
        {v.map((t, i) => (hover === i ? <circle key={i} class="viz-dot s1 ring" cx={X(i)} cy={Y(t)} r={4} /> : null))}
      </Frame>
      <div class="viz-legend">
        <span class="muted">1 秒あたりの手数</span>
      </div>
    </>
  );
}

export function Chart({ kind, solves }: { kind: ChartKind; solves: Solve[] }) {
  const [ref, width] = useWidth();
  return (
    <div class="viz" ref={ref}>
      {width > 0 &&
        (kind === "timeline" ? <Timeline solves={solves} width={width} /> : kind === "splits" ? <Splits solves={solves} width={width} /> : kind === "histogram" ? <Histogram solves={solves} width={width} /> : <Tps solves={solves} width={width} />)}
    </div>
  );
}

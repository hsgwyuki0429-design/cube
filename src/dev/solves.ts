/**
 * 計測結果の保持と集計。
 * フェーズ0の成果物は「Go/No-Go を判定できる数値」なので、ここが出口になる。
 */

export interface SolveResult {
  id: string;
  createdAt: number;
  /** 狙った TPS（3 / 5 / 8 など）。集計のキーになる */
  targetTps: number | null;
  scramble: string;
  /** 最初の確定手から完成検出まで（ms） */
  timeMs: number;
  moveCount: number;
  tps: number;
  lostCount: number;
  meanConfidence: number;
  /** 完成状態まで追い切れたか */
  completed: boolean;
  abortReason?: string;
  /** 手順ログ（時刻付き） */
  moves: { notation: string; t: number; confidence: number }[];
  /** 参考: そのソルブ中の処理性能 */
  meanProcMs: number;
  meanTotalMs: number;
  cameraFps: number;
  processedFps: number;
}

export interface TpsBucket {
  targetTps: number | null;
  attempts: number;
  completed: number;
  completionRate: number;
  meanTimeMs: number;
  meanTps: number;
  meanLost: number;
  meanConfidence: number;
}

export function bucketByTps(solves: SolveResult[]): TpsBucket[] {
  const keys = [...new Set(solves.map((s) => s.targetTps))].sort(
    (a, b) => (a ?? 1e9) - (b ?? 1e9),
  );
  return keys.map((k) => {
    const list = solves.filter((s) => s.targetTps === k);
    const done = list.filter((s) => s.completed);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
    return {
      targetTps: k,
      attempts: list.length,
      completed: done.length,
      completionRate: list.length ? done.length / list.length : NaN,
      meanTimeMs: mean(done.map((s) => s.timeMs)),
      meanTps: mean(done.map((s) => s.tps)),
      meanLost: mean(list.map((s) => s.lostCount)),
      meanConfidence: mean(list.map((s) => s.meanConfidence)),
    };
  });
}

/** Go/No-Go の各指標。CLAUDE.md / 企画書 §6 の合格ライン。 */
export interface GoNoGoRow {
  metric: string;
  threshold: string;
  value: number;
  display: string;
  pass: boolean | null;
  /** 判定に足るサンプルが集まっているか */
  enough: boolean;
  note?: string;
}

export interface GoNoGoInput {
  colorAccuracy: number | null;
  colorSamples: number;
  solves: SolveResult[];
  latencyMs: number | null;
  latencySamples: number;
  cameraFps: number | null;
  /** 判定に必要な最小ソルブ数 */
  minSolves?: number;
}

export function evaluateGoNoGo(i: GoNoGoInput): GoNoGoRow[] {
  const minSolves = i.minSolves ?? 5;
  const buckets = bucketByTps(i.solves);
  const at = (tps: number) => buckets.find((b) => b.targetTps === tps);
  const rows: GoNoGoRow[] = [];
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

  rows.push({
    metric: '色分類精度（可視ステッカー）',
    threshold: '98%以上',
    value: i.colorAccuracy ?? NaN,
    display: i.colorAccuracy === null ? '未計測' : pct(i.colorAccuracy),
    pass: i.colorAccuracy === null ? null : i.colorAccuracy >= 0.98,
    enough: i.colorSamples >= 500,
    note: i.colorSamples < 500 ? `サンプル ${i.colorSamples} セル（500以上必要）` : undefined,
  });

  for (const [tps, line] of [[5, 0.8], [8, 0.5]] as [number, number][]) {
    const b = at(tps);
    rows.push({
      metric: `TPS ${tps} での完走率`,
      threshold: `${line * 100}%以上`,
      value: b?.completionRate ?? NaN,
      display: b ? `${pct(b.completionRate)} (${b.completed}/${b.attempts})` : '未計測',
      pass: b && b.attempts >= minSolves ? b.completionRate >= line : null,
      enough: (b?.attempts ?? 0) >= minSolves,
      note: b && b.attempts < minSolves ? `試行 ${b.attempts} 回（${minSolves} 回以上必要）` : undefined,
    });
  }

  rows.push({
    metric: '処理レイテンシ',
    threshold: '16ms/フレーム以下',
    value: i.latencyMs ?? NaN,
    display: i.latencyMs === null ? '未計測' : `${i.latencyMs.toFixed(2)} ms`,
    pass: i.latencyMs === null ? null : i.latencyMs <= 16,
    enough: i.latencySamples >= 100,
    note: i.latencySamples < 100 ? `サンプル ${i.latencySamples} フレーム（100以上必要）` : undefined,
  });

  rows.push({
    metric: 'カメラ実測fps',
    threshold: '60以上',
    value: i.cameraFps ?? NaN,
    display: i.cameraFps === null ? '未計測' : i.cameraFps.toFixed(1),
    pass: i.cameraFps === null ? null : i.cameraFps >= 60,
    enough: i.cameraFps !== null,
  });

  return rows;
}

/** 全指標が判定可能かつ合格なら Go。1つでも未計測なら判定保留。 */
export function overallVerdict(rows: GoNoGoRow[]): 'GO' | 'NO-GO' | 'PENDING' {
  if (rows.some((r) => r.pass === null || !r.enough)) return 'PENDING';
  return rows.every((r) => r.pass) ? 'GO' : 'NO-GO';
}

const KEY = 'cubevision.solves.v1';

export function loadSolves(): SolveResult[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as SolveResult[]) : [];
  } catch {
    return [];
  }
}

export function saveSolves(list: SolveResult[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch { /* noop */ }
}

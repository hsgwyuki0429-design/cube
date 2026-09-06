import { describe, it, expect } from 'vitest';
import { bucketByTps, evaluateGoNoGo, overallVerdict, type SolveResult } from '../src/dev/solves';

function solve(o: Partial<SolveResult> = {}): SolveResult {
  return {
    id: Math.random().toString(36).slice(2), createdAt: 0, targetTps: 5, scramble: 'R U',
    timeMs: 12000, moveCount: 55, tps: 4.6, lostCount: 0, meanConfidence: 0.8,
    completed: true, moves: [], meanProcMs: 4, meanTotalMs: 10, cameraFps: 60, processedFps: 60, ...o,
  };
}

describe('TPS 別集計', () => {
  it('目標TPSごとに完走率をまとめる', () => {
    const list = [
      solve({ targetTps: 5 }), solve({ targetTps: 5 }), solve({ targetTps: 5, completed: false }),
      solve({ targetTps: 8, completed: false }), solve({ targetTps: 8 }),
      solve({ targetTps: 3 }),
    ];
    const b = bucketByTps(list);
    expect(b.map((x) => x.targetTps)).toEqual([3, 5, 8]);
    expect(b[1].attempts).toBe(3);
    expect(b[1].completed).toBe(2);
    expect(b[1].completionRate).toBeCloseTo(2 / 3, 6);
    expect(b[2].completionRate).toBe(0.5);
    expect(b[0].completionRate).toBe(1);
  });

  it('完走したソルブだけで平均タイムを出す', () => {
    const b = bucketByTps([
      solve({ timeMs: 10000 }), solve({ timeMs: 20000 }), solve({ timeMs: 999999, completed: false }),
    ]);
    expect(b[0].meanTimeMs).toBe(15000);
    expect(b[0].meanLost).toBe(0); // LOST は全試行の平均
  });

  it('空でも落ちない', () => {
    expect(bucketByTps([])).toEqual([]);
  });
});

describe('Go/No-Go 判定', () => {
  const full = {
    colorAccuracy: 0.99, colorSamples: 1000,
    latencyMs: 12, latencySamples: 300, cameraFps: 90,
    solves: [
      ...Array.from({ length: 10 }, () => solve({ targetTps: 5 })),
      ...Array.from({ length: 10 }, (_, i) => solve({ targetTps: 8, completed: i < 6 })),
    ],
  };

  it('全指標が合格なら GO', () => {
    const rows = evaluateGoNoGo(full);
    expect(rows.length).toBe(5);
    expect(rows.every((r) => r.pass)).toBe(true);
    expect(overallVerdict(rows)).toBe('GO');
  });

  it('1つでも落ちれば NO-GO', () => {
    const rows = evaluateGoNoGo({ ...full, colorAccuracy: 0.95 });
    expect(overallVerdict(rows)).toBe('NO-GO');
    expect(rows[0].pass).toBe(false);
  });

  it('未計測があれば PENDING（勝手に GO にしない）', () => {
    expect(overallVerdict(evaluateGoNoGo({ ...full, colorAccuracy: null }))).toBe('PENDING');
    expect(overallVerdict(evaluateGoNoGo({ ...full, cameraFps: null }))).toBe('PENDING');
    expect(overallVerdict(evaluateGoNoGo({ ...full, solves: [] }))).toBe('PENDING');
  });

  it('サンプル数が足りなければ判定しない', () => {
    const rows = evaluateGoNoGo({ ...full, colorSamples: 50 });
    expect(rows[0].enough).toBe(false);
    expect(rows[0].note).toContain('500');
    expect(overallVerdict(rows)).toBe('PENDING');
  });

  it('試行回数が足りない TPS は pass を null にする', () => {
    const rows = evaluateGoNoGo({
      ...full,
      solves: [solve({ targetTps: 5 }), solve({ targetTps: 5 })],
    });
    const tps5 = rows.find((r) => r.metric.includes('TPS 5'))!;
    expect(tps5.pass).toBeNull();
    expect(tps5.note).toContain('5 回以上');
  });

  it('合格ラインは企画書 §6 と一致している', () => {
    const rows = evaluateGoNoGo(full);
    expect(rows.map((r) => r.threshold)).toEqual([
      '98%以上', '80%以上', '50%以上', '16ms/フレーム以下', '60以上',
    ]);
  });

  it('レイテンシは 16ms 丁度なら合格', () => {
    expect(evaluateGoNoGo({ ...full, latencyMs: 16 }).find((r) => r.metric.includes('レイテンシ'))!.pass).toBe(true);
    expect(evaluateGoNoGo({ ...full, latencyMs: 16.1 }).find((r) => r.metric.includes('レイテンシ'))!.pass).toBe(false);
  });
});

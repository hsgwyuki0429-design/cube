/**
 * 回帰テスト。fixtures/ の録画を全部リプレイし、追跡成功率と誤検出数を出す。
 * アルゴリズムや閾値を触るたびにこれを回す（CLAUDE.md「回帰テスト」）。
 *
 * 現在の fixtures は合成データ。実機録画を置いたら synthetic フラグで区別される。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSession } from '../src/dev/recorder';
import { replaySession } from '../src/dev/replay';
import { defaultThresholds } from '../src/core/tracker';

const dir = join(process.cwd(), 'fixtures');
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

interface Row {
  file: string;
  synthetic: boolean;
  moves: number;
  matched: number;
  complete: boolean;
  falsePositives: number;
  missed: number;
  lost: number;
  stateOk: boolean;
  frames: number;
}

const rows: Row[] = [];

describe('回帰: fixtures のリプレイ', () => {
  it('fixtures が存在する', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file}`, () => {
      const session = parseSession(readFileSync(join(dir, file), 'utf8'));
      const r = replaySession(session, { thresholds: defaultThresholds() });
      const c = r.comparison;
      expect(c, `${file} に expectedMoves が無い`).not.toBeNull();
      rows.push({
        file,
        synthetic: !!session.synthetic,
        moves: c!.expected.length,
        matched: c!.matchedPrefix,
        complete: c!.complete,
        falsePositives: c!.falsePositives,
        missed: c!.missed,
        lost: r.lostCount,
        stateOk: c!.finalStateMatches,
        frames: r.frames,
      });
      // 誤検出（期待より多く手を出す）は最悪の失敗なので個別に見張る
      expect(c!.falsePositives, `${file}: 誤検出`).toBeLessThanOrEqual(2);
    });
  }

  it('サマリ', () => {
    const pad = (s: string | number, n: number) => String(s).padEnd(n);
    const lines = [
      '',
      `${pad('fixture', 24)}${pad('手数', 6)}${pad('一致', 6)}${pad('完走', 6)}${pad('誤検出', 8)}${pad('取零', 6)}${pad('LOST', 6)}${pad('最終状態', 8)}`,
      '-'.repeat(74),
    ];
    for (const r of rows) {
      lines.push(
        pad(r.file.replace('.json', ''), 24) + pad(r.moves, 6) + pad(r.matched, 6) +
        pad(r.complete ? 'OK' : 'NG', 6) + pad(r.falsePositives, 8) + pad(r.missed, 6) +
        pad(r.lost, 6) + pad(r.stateOk ? 'OK' : 'NG', 8),
      );
    }
    const complete = rows.filter((r) => r.complete).length;
    const totalMoves = rows.reduce((a, r) => a + r.moves, 0);
    const totalMatched = rows.reduce((a, r) => a + r.matched, 0);
    lines.push('-'.repeat(74));
    lines.push(`完走率 ${complete}/${rows.length} (${((complete / rows.length) * 100).toFixed(0)}%)  ` +
      `手一致率 ${totalMatched}/${totalMoves} (${((totalMatched / totalMoves) * 100).toFixed(1)}%)  ` +
      `総誤検出 ${rows.reduce((a, r) => a + r.falsePositives, 0)}`);
    if (rows.every((r) => r.synthetic)) {
      lines.push('※ 全て合成データ。Go/No-Go の判定には実機録画が必要。');
    }
    console.log(lines.join('\n'));
    expect(rows.length).toBe(files.length);
  });
});

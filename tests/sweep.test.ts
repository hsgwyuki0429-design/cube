/**
 * 閾値スイープ。同一の録画データに対して複数の設定を流し、完走率と誤検出を比較する。
 * リプレイ基盤の本来の用途。通常のテスト実行では走らない。
 *   npm run sweep
 */
import { it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSession } from '../src/dev/recorder';
import { replaySession } from '../src/dev/replay';
import { defaultThresholds, PRESETS } from '../src/core/tracker';

const enabled = process.env.SWEEP === '1';

it.skipIf(!enabled)('プリセットを全 fixture で比較する', { timeout: 120000 }, () => {
  const dir = join(process.cwd(), 'fixtures');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const sessions = files.map((f) => ({ f, s: parseSession(readFileSync(join(dir, f), 'utf8')) }));
  expect(sessions.length).toBeGreaterThan(0);

  const pad = (v: unknown, n: number) => String(v).padEnd(n);
  const head = pad('preset', 26) + files.map((f) => pad(f.replace('.json', ''), 20)).join('') + '完走  誤検出';
  const lines = ['', head, '-'.repeat(head.length)];

  for (const v of PRESETS) {
    let complete = 0;
    let fp = 0;
    const cells: string[] = [];
    for (const { s } of sessions) {
      const r = replaySession(s, { thresholds: { ...defaultThresholds(), ...v.thresholds } });
      const c = r.comparison!;
      if (c.complete) complete++;
      fp += c.falsePositives;
      cells.push(pad(`${c.matchedPrefix}/${c.expected.length} ${c.complete ? 'OK' : 'NG'}${c.falsePositives ? `+${c.falsePositives}` : ''}`, 20));
    }
    lines.push(pad(v.name, 26) + cells.join('') + `${complete}/${sessions.length}   ${fp}`);
  }
  lines.push('');
  lines.push('※ 現在の fixtures は合成データ。実機録画を fixtures/ に置いてから判断すること。');
  console.log(lines.join('\n'));
});

/**
 * 合成 fixture の生成。通常のテスト実行では走らない。
 *   npm run fixtures
 */
import { it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_SPECS, buildFixture } from '../src/dev/fixtures';

const enabled = process.env.GEN_FIXTURES === '1';

it.skipIf(!enabled)('fixtures/ を再生成する', () => {
  const outDir = join(process.cwd(), 'fixtures');
  mkdirSync(outDir, { recursive: true });
  for (const spec of FIXTURE_SPECS) {
    const session = buildFixture(spec);
    const json = JSON.stringify(session);
    writeFileSync(join(outDir, spec.file), json);
    console.log(`${spec.file}: ${session.frames.length} frames, ${session.expectedMoves?.length} moves, ${(json.length / 1024).toFixed(0)} KB`);
    expect(session.frames.length).toBeGreaterThan(0);
  }
});

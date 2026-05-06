import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ETSProjectMap } from '../../src/ets/projectMap';

const SAMPLES = [
  '/home/innovera/projects/software/eelectron-knxip/ga-example comma.csv',
  '/home/innovera/projects/software/eelectron-knxip/ga-example semicolon.csv',
  '/home/innovera/projects/software/eelectron-knxip/ga-example tabular.csv',
] as const;

const HAVE_SAMPLES = SAMPLES.every((p) => existsSync(p));

describe('parseEtsCsv against real ETS exports', () => {
  for (const path of SAMPLES) {
    it(`parses ${path.split('/').pop()}`, { skip: !HAVE_SAMPLES }, () => {
      const csv = readFileSync(path, 'utf8');
      const map = new ETSProjectMap();
      const result = map.loadCsv(csv);
      // Real GAs only — parent pseudo-rows skipped.
      assert.ok(result.entries > 50, `expected > 50 entries, got ${result.entries}`);
      // No warnings about pseudo-GAs ("1/-/-", "1/0/-")
      const pseudoWarn = result.warnings.find((w) => /\d\/-\/-|\d\/\d+\/-/.test(w));
      assert.equal(
        pseudoWarn,
        undefined,
        `unexpected warning about pseudo-GA: ${pseudoWarn}`,
      );
      // Most/all DPTs are recognized (DPST-1-* / DPST-5-*)
      assert.ok(
        result.withDpt > 0,
        `expected some entries with known DPT, got ${result.withDpt}`,
      );
      // Picked names from the Sub column
      const example = map.list().find((e) => e.ga === '1/0/1');
      assert.ok(example, 'expected GA 1/0/1 to be present');
      assert.ok(example!.name.length > 0, 'expected a name from the Sub column');
    });
  }

  it('all three formats produce the same entries', { skip: !HAVE_SAMPLES }, () => {
    const maps = SAMPLES.map((path) => {
      const m = new ETSProjectMap();
      m.loadCsv(readFileSync(path, 'utf8'));
      return m;
    });
    const counts = maps.map((m) => m.size());
    assert.ok(
      counts.every((c) => c === counts[0]),
      `entry counts differ across delimiters: ${counts.join(', ')}`,
    );
    // Compare a sample of GAs across the three maps
    const reference = maps[0]!;
    for (const entry of reference.list().slice(0, 10)) {
      for (const other of maps.slice(1)) {
        const otherEntry = other.get(entry.ga);
        assert.ok(otherEntry, `GA ${entry.ga} missing in another map`);
        assert.equal(otherEntry!.dpt, entry.dpt, `DPT mismatch for ${entry.ga}`);
      }
    }
  });
});

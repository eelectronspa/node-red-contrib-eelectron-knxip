import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { compileCron } from '../../src/util/cron';

function at(y: number, mo: number, d: number, h: number, mi: number, dow?: number): Date {
  // Build a Date in local time. dow is informational — the Date's getDay()
  // depends on (y, mo, d). When the test cares about a specific weekday we
  // pick a known anchor below.
  void dow;
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

describe('compileCron — basic matchers', () => {
  it('matches every minute with all-stars', () => {
    const m = compileCron('* * * * *');
    assert.equal(m.matches(at(2026, 5, 7, 12, 34)), true);
    assert.equal(m.matches(at(2026, 1, 1, 0, 0)), true);
  });

  it('matches a single literal minute', () => {
    const m = compileCron('15 * * * *');
    assert.equal(m.matches(at(2026, 5, 7, 12, 15)), true);
    assert.equal(m.matches(at(2026, 5, 7, 12, 14)), false);
    assert.equal(m.matches(at(2026, 5, 7, 12, 16)), false);
  });

  it('matches a step expression', () => {
    const m = compileCron('*/15 * * * *');
    assert.equal(m.matches(at(2026, 5, 7, 0, 0)), true);
    assert.equal(m.matches(at(2026, 5, 7, 0, 15)), true);
    assert.equal(m.matches(at(2026, 5, 7, 0, 30)), true);
    assert.equal(m.matches(at(2026, 5, 7, 0, 45)), true);
    assert.equal(m.matches(at(2026, 5, 7, 0, 14)), false);
  });

  it('matches a list', () => {
    const m = compileCron('0,15,30,45 * * * *');
    assert.equal(m.matches(at(2026, 5, 7, 12, 0)), true);
    assert.equal(m.matches(at(2026, 5, 7, 12, 15)), true);
    assert.equal(m.matches(at(2026, 5, 7, 12, 1)), false);
  });

  it('matches a range', () => {
    const m = compileCron('* 9-17 * * *');
    assert.equal(m.matches(at(2026, 5, 7, 9, 0)), true);
    assert.equal(m.matches(at(2026, 5, 7, 17, 30)), true);
    assert.equal(m.matches(at(2026, 5, 7, 18, 0)), false);
    assert.equal(m.matches(at(2026, 5, 7, 8, 0)), false);
  });

  it('matches a range with step', () => {
    const m = compileCron('0 8-18/2 * * *');
    assert.equal(m.matches(at(2026, 5, 7, 8, 0)), true);
    assert.equal(m.matches(at(2026, 5, 7, 10, 0)), true);
    assert.equal(m.matches(at(2026, 5, 7, 9, 0)), false);
  });

  it('"every day at 07:00"', () => {
    const m = compileCron('0 7 * * *');
    assert.equal(m.matches(at(2026, 5, 7, 7, 0)), true);
    assert.equal(m.matches(at(2026, 5, 7, 7, 1)), false);
    assert.equal(m.matches(at(2026, 5, 7, 6, 59)), false);
  });
});

describe('compileCron — dom / dow combination', () => {
  it('Vixie OR: both restricted → either matches', () => {
    // 1st of any month OR Monday at 09:00.
    // Pick a date that is the 5th and a Monday → only dow side matches.
    // 2026-05-04 was a Monday in this calendar simulation — verify with the actual.
    // Use 2026-05-04 (a Monday) and 2026-05-01 (a Friday).
    const m = compileCron('0 9 1 * 1');
    const monday04 = new Date(2026, 4, 4, 9, 0); // Monday at 09:00
    const friday01 = new Date(2026, 4, 1, 9, 0); // Day-1 (Friday) at 09:00
    const tuesday05 = new Date(2026, 4, 5, 9, 0); // Tuesday — neither
    assert.equal(monday04.getDay(), 1); // sanity
    assert.equal(friday01.getDate(), 1);
    assert.equal(m.matches(monday04), true, 'dow alone should match');
    assert.equal(m.matches(friday01), true, 'dom alone should match');
    assert.equal(m.matches(tuesday05), false);
  });

  it('only dom restricted → AND', () => {
    const m = compileCron('0 9 15 * *');
    assert.equal(m.matches(at(2026, 5, 15, 9, 0)), true);
    assert.equal(m.matches(at(2026, 5, 16, 9, 0)), false);
  });

  it('only dow restricted → AND (matches every Friday at 17:00)', () => {
    const m = compileCron('0 17 * * 5');
    // 2026-05-01 was a Friday
    const friday = new Date(2026, 4, 1, 17, 0);
    const saturday = new Date(2026, 4, 2, 17, 0);
    assert.equal(friday.getDay(), 5);
    assert.equal(m.matches(friday), true);
    assert.equal(m.matches(saturday), false);
  });

  it('accepts 7 as Sunday', () => {
    const m = compileCron('0 12 * * 7');
    // 2026-05-03 was a Sunday
    const sunday = new Date(2026, 4, 3, 12, 0);
    assert.equal(sunday.getDay(), 0);
    assert.equal(m.matches(sunday), true);
  });
});

describe('compileCron — error cases', () => {
  it('rejects wrong field count', () => {
    assert.throws(() => compileCron('* * * *'));
    assert.throws(() => compileCron('* * * * * *'));
    assert.throws(() => compileCron(''));
  });

  it('rejects out-of-range values', () => {
    assert.throws(() => compileCron('60 * * * *'));
    assert.throws(() => compileCron('* 24 * * *'));
    assert.throws(() => compileCron('* * 0 * *'));
    assert.throws(() => compileCron('* * * 0 *'));
    assert.throws(() => compileCron('* * * 13 *'));
  });

  it('rejects bad step', () => {
    assert.throws(() => compileCron('*/0 * * * *'));
    assert.throws(() => compileCron('*/x * * * *'));
  });

  it('rejects inverted ranges', () => {
    assert.throws(() => compileCron('30-10 * * * *'));
  });
});

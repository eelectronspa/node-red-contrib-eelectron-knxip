import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { normalizeDptId } from '../../src/ets/dptNormalize';

describe('normalizeDptId', () => {
  it('normalizes DPST-N-M form', () => {
    const r = normalizeDptId('DPST-1-1');
    assert.equal(r?.id, '1.001');
    assert.equal(r?.main, 1);
    assert.equal(r?.sub, 1);
    assert.equal(r?.registered, true);
  });

  it('zero-pads sub to three digits', () => {
    assert.equal(normalizeDptId('DPST-9-7')?.id, '9.007');
    assert.equal(normalizeDptId('DPST-232-600')?.id, '232.600');
  });

  it('handles DPT-N.M form', () => {
    assert.equal(normalizeDptId('DPT-1.001')?.id, '1.001');
    assert.equal(normalizeDptId('DPT-9.1')?.id, '9.001');
  });

  it('handles plain N.M and N forms', () => {
    assert.equal(normalizeDptId('1.001')?.id, '1.001');
    // Plain "1" with no sub falls back to a registered sub (1.001).
    assert.equal(normalizeDptId('1')?.id, '1.001');
  });

  it('main-only DPT-N falls back to a registered sub', () => {
    const r = normalizeDptId('DPT-1');
    assert.equal(r?.sub, null);
    assert.equal(r?.id, '1.001');
    assert.equal(r?.registered, true);
  });

  it('main-only DPT-7 falls back to 7.001', () => {
    const r = normalizeDptId('DPT-7');
    assert.equal(r?.id, '7.001');
    assert.equal(r?.registered, true);
  });

  it('flags unregistered ids', () => {
    // 99.999 is not in our codec registry
    assert.equal(normalizeDptId('99.999')?.registered, false);
    // 1.001 is
    assert.equal(normalizeDptId('1.001')?.registered, true);
  });

  it('returns null on empty / invalid', () => {
    assert.equal(normalizeDptId(''), null);
    assert.equal(normalizeDptId(null), null);
    assert.equal(normalizeDptId(undefined), null);
    assert.equal(normalizeDptId('garbage'), null);
  });
});

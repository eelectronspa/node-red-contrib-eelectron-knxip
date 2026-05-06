import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { GroupAddress } from '../../src/core/address';
import { compileGAPattern, compileGAPatterns } from '../../src/core/gaMatcher';

const r = (ga: string) => new GroupAddress(ga).raw;

describe('compileGAPattern', () => {
  it('exact match for non-wildcard pattern', () => {
    const m = compileGAPattern('1/2/3');
    assert.equal(m(r('1/2/3')), true);
    assert.equal(m(r('1/2/4')), false);
  });

  it('matches with sub wildcard', () => {
    const m = compileGAPattern('1/2/*');
    assert.equal(m(r('1/2/0')), true);
    assert.equal(m(r('1/2/255')), true);
    assert.equal(m(r('1/3/0')), false);
    assert.equal(m(r('2/2/0')), false);
  });

  it('matches with middle wildcard', () => {
    const m = compileGAPattern('1/*/5');
    assert.equal(m(r('1/0/5')), true);
    assert.equal(m(r('1/7/5')), true);
    assert.equal(m(r('1/0/4')), false);
  });

  it('matches with main wildcard', () => {
    const m = compileGAPattern('*/2/3');
    assert.equal(m(r('0/2/3')), true);
    assert.equal(m(r('15/2/3')), true);
    assert.equal(m(r('0/2/4')), false);
  });

  it('matches everything with */*/*', () => {
    const m = compileGAPattern('*/*/*');
    assert.equal(m(r('0/0/0')), true);
    assert.equal(m(r('1/2/3')), true);
    assert.equal(m(r('31/7/255')), true);
  });

  it('rejects wildcard patterns without 3 segments', () => {
    assert.throws(() => compileGAPattern('1/*'));
    assert.throws(() => compileGAPattern('*'));
  });

  it('rejects out-of-range numeric segments', () => {
    assert.throws(() => compileGAPattern('32/0/0'));
    assert.throws(() => compileGAPattern('0/8/0'));
    assert.throws(() => compileGAPattern('0/0/256'));
  });
});

describe('compileGAPatterns', () => {
  it('returns null for empty list', () => {
    assert.equal(compileGAPatterns([]), null);
  });

  it('matches if any pattern matches', () => {
    const m = compileGAPatterns(['1/2/3', '5/*/*'])!;
    assert.equal(m(r('1/2/3')), true);
    assert.equal(m(r('5/0/0')), true);
    assert.equal(m(r('5/7/255')), true);
    assert.equal(m(r('2/2/2')), false);
  });
});

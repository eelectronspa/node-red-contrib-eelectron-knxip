import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  CouldNotParseAddress,
  GroupAddress,
  IndividualAddress,
} from '../../src/core/address';

describe('IndividualAddress', () => {
  it('parses 1.2.3 form', () => {
    const a = new IndividualAddress('1.2.3');
    assert.equal(a.area, 1);
    assert.equal(a.main, 2);
    assert.equal(a.line, 3);
    assert.equal(a.raw, (1 << 12) | (2 << 8) | 3);
    assert.equal(a.toString(), '1.2.3');
  });

  it('round-trips through KNX bytes', () => {
    const a = new IndividualAddress('15.15.255');
    const buf = a.toKnx();
    assert.equal(buf.length, 2);
    const back = IndividualAddress.fromKnx(buf);
    assert.equal(back.raw, a.raw);
  });

  it('accepts a raw integer', () => {
    const a = new IndividualAddress(0x1234);
    assert.equal(a.area, 1);
    assert.equal(a.main, 2);
    assert.equal(a.line, 0x34);
  });

  it('rejects out-of-range parts', () => {
    assert.throws(() => new IndividualAddress('16.0.0'), CouldNotParseAddress);
    assert.throws(() => new IndividualAddress('0.16.0'), CouldNotParseAddress);
    assert.throws(() => new IndividualAddress('0.0.256'), CouldNotParseAddress);
  });

  it('rejects invalid types', () => {
    assert.throws(() => new IndividualAddress(-1), CouldNotParseAddress);
    assert.throws(() => new IndividualAddress(70000), CouldNotParseAddress);
    assert.throws(() => new IndividualAddress('not.an.addr'), CouldNotParseAddress);
  });

  it('isDevice reflects line != 0', () => {
    assert.equal(new IndividualAddress('1.2.0').isDevice, false);
    assert.equal(new IndividualAddress('1.2.1').isDevice, true);
  });
});

describe('GroupAddress', () => {
  it('parses long form 1/2/3', () => {
    const g = new GroupAddress('1/2/3');
    assert.equal(g.main, 1);
    assert.equal(g.middle, 2);
    assert.equal(g.sub, 3);
    assert.equal(g.raw, (1 << 11) | (2 << 8) | 3);
    assert.equal(g.toString(), '1/2/3');
  });

  it('parses short form 1/123', () => {
    const g = new GroupAddress('1/123', 'short');
    assert.equal(g.main, 1);
    assert.equal(g.middle, null);
    assert.equal(g.sub, 123);
    assert.equal(g.raw, (1 << 11) | 123);
    assert.equal(g.toString(), '1/123');
  });

  it('parses free form', () => {
    const g = new GroupAddress('1234', 'free');
    assert.equal(g.main, null);
    assert.equal(g.middle, null);
    assert.equal(g.sub, 1234);
    assert.equal(g.raw, 1234);
    assert.equal(g.toString(), '1234');
  });

  it('round-trips through KNX bytes', () => {
    const g = new GroupAddress('31/7/255');
    const buf = g.toKnx();
    assert.equal(buf.length, 2);
    const back = GroupAddress.fromKnx(buf);
    assert.equal(back.raw, g.raw);
  });

  it('rejects out-of-range parts', () => {
    assert.throws(() => new GroupAddress('32/0/0'), CouldNotParseAddress);
    assert.throws(() => new GroupAddress('0/8/0'), CouldNotParseAddress);
    assert.throws(() => new GroupAddress('0/0/256'), CouldNotParseAddress);
  });

  it('rejects invalid format strings', () => {
    assert.throws(() => new GroupAddress('garbage'), CouldNotParseAddress);
  });
});

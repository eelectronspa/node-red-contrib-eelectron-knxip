import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ConversionError } from '../../src/core/errors';
import {
  encodeTpci,
  resolveTpci,
  tAck,
  tConnect,
  tDataBroadcast,
  tDataConnected,
  tDataGroup,
  tDataIndividual,
  tDataTagGroup,
  tDisconnect,
  tNak,
} from '../../src/core/tpci';

describe('encodeTpci', () => {
  it('encodes data TPCIs as zero (APCI bits go in lower 2 bits)', () => {
    assert.equal(encodeTpci(tDataGroup()), 0);
    assert.equal(encodeTpci(tDataBroadcast()), 0);
    assert.equal(encodeTpci(tDataIndividual()), 0);
  });

  it('encodes TDataConnected with sequence', () => {
    // numbered (0x40) | (seq << 2)
    assert.equal(encodeTpci(tDataConnected(5)), 0x40 | (5 << 2));
  });

  it('encodes TDataTagGroup with sequence=1', () => {
    assert.equal(encodeTpci(tDataTagGroup()), 1 << 2);
  });

  it('encodes control TPCIs', () => {
    assert.equal(encodeTpci(tConnect()), 0x80 | 0b00);
    assert.equal(encodeTpci(tDisconnect()), 0x80 | 0b01);
    assert.equal(encodeTpci(tAck(3)), 0x80 | 0x40 | (3 << 2) | 0b10);
    assert.equal(encodeTpci(tNak(7)), 0x80 | 0x40 | (7 << 2) | 0b11);
  });
});

describe('resolveTpci', () => {
  it('resolves group data', () => {
    assert.deepEqual(resolveTpci(0, true, false), { kind: 'TDataGroup' });
  });

  it('resolves broadcast when dst is zero', () => {
    assert.deepEqual(resolveTpci(0, true, true), { kind: 'TDataBroadcast' });
  });

  it('resolves tag group on group dst with seq=1', () => {
    assert.deepEqual(resolveTpci(1 << 2, true, false), { kind: 'TDataTagGroup' });
  });

  it('rejects control bits on group address', () => {
    assert.throws(() => resolveTpci(0x80, true, false), ConversionError);
    assert.throws(() => resolveTpci(0x40, true, false), ConversionError);
  });

  it('resolves individual data', () => {
    assert.deepEqual(resolveTpci(0, false, false), { kind: 'TDataIndividual' });
  });

  it('resolves connected data with sequence', () => {
    assert.deepEqual(resolveTpci(0x40 | (4 << 2), false, false), {
      kind: 'TDataConnected',
      sequenceNumber: 4,
    });
  });

  it('rejects sequence on unnumbered data', () => {
    // control=0, numbered=0, sequence != 0 → invalid for individual
    assert.throws(() => resolveTpci(2 << 2, false, false), ConversionError);
  });

  it('resolves control TPCIs', () => {
    assert.deepEqual(resolveTpci(0x80, false, false), { kind: 'TConnect' });
    assert.deepEqual(resolveTpci(0x80 | 0b01, false, false), { kind: 'TDisconnect' });
    assert.deepEqual(resolveTpci(0x80 | 0x40 | (5 << 2) | 0b10, false, false), {
      kind: 'TAck',
      sequenceNumber: 5,
    });
    assert.deepEqual(resolveTpci(0x80 | 0x40 | (2 << 2) | 0b11, false, false), {
      kind: 'TNak',
      sequenceNumber: 2,
    });
  });

  it('round-trips encode → resolve for control variants', () => {
    const cases = [tConnect(), tDisconnect(), tAck(3), tNak(7)];
    for (const original of cases) {
      const byte = encodeTpci(original);
      const back = resolveTpci(byte, false, false);
      assert.deepEqual(back, original);
    }
  });
});

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  bytesValue,
  decodeApci,
  encodeApci,
  groupValueRead,
  groupValueResponse,
  groupValueWrite,
  smallValue,
} from '../../src/core/apci';
import { ConversionError } from '../../src/core/errors';

describe('encodeApci', () => {
  it('encodes GroupValueRead as 0x00 0x00', () => {
    const buf = encodeApci(groupValueRead());
    assert.deepEqual(Array.from(buf), [0x00, 0x00]);
  });

  it('encodes GroupValueWrite small=1 as 0x00 0x81', () => {
    const buf = encodeApci(groupValueWrite(smallValue(1)));
    assert.deepEqual(Array.from(buf), [0x00, 0x81]);
  });

  it('encodes GroupValueWrite small=0 as 0x00 0x80', () => {
    const buf = encodeApci(groupValueWrite(smallValue(0)));
    assert.deepEqual(Array.from(buf), [0x00, 0x80]);
  });

  it('encodes GroupValueWrite bytes (>6 bit payload)', () => {
    const buf = encodeApci(groupValueWrite(bytesValue(Buffer.from([0x12, 0x34]))));
    assert.deepEqual(Array.from(buf), [0x00, 0x80, 0x12, 0x34]);
  });

  it('encodes GroupValueResponse small=63 (max 6-bit)', () => {
    const buf = encodeApci(groupValueResponse(smallValue(63)));
    assert.deepEqual(Array.from(buf), [0x00, 0x40 | 63]);
  });

  it('rejects out-of-range small payload', () => {
    assert.throws(() => smallValue(64), ConversionError);
    assert.throws(() => smallValue(-1), ConversionError);
  });
});

describe('decodeApci', () => {
  it('decodes GroupValueRead', () => {
    assert.deepEqual(decodeApci(Buffer.from([0x00, 0x00])), { kind: 'GroupValueRead' });
  });

  it('decodes GroupValueWrite small payload', () => {
    assert.deepEqual(decodeApci(Buffer.from([0x00, 0x81])), {
      kind: 'GroupValueWrite',
      data: { kind: 'small', value: 1 },
    });
  });

  it('decodes GroupValueWrite bytes payload', () => {
    const decoded = decodeApci(Buffer.from([0x00, 0x80, 0xab, 0xcd]));
    assert.equal(decoded.kind, 'GroupValueWrite');
    if (decoded.kind === 'GroupValueWrite') {
      assert.equal(decoded.data.kind, 'bytes');
      if (decoded.data.kind === 'bytes') {
        assert.deepEqual(Array.from(decoded.data.value), [0xab, 0xcd]);
      }
    }
  });

  it('decodes GroupValueResponse', () => {
    assert.deepEqual(decodeApci(Buffer.from([0x00, 0x40])), {
      kind: 'GroupValueResponse',
      data: { kind: 'small', value: 0 },
    });
  });

  it('masks the TPCI bits before classifying', () => {
    // top 6 bits of byte 0 are TPCI; only bottom 2 bits affect the APCI service.
    // 0xfc has TPCI bits all set, APCI bits zero — should still resolve to GroupValueRead.
    assert.deepEqual(decodeApci(Buffer.from([0xfc, 0x00])), { kind: 'GroupValueRead' });
  });

  it('returns Unknown for unsupported service codes', () => {
    // 0x00 0xc0 → INDIVIDUAL_ADDRESS_WRITE — out of scope for now
    const decoded = decodeApci(Buffer.from([0x00, 0xc0]));
    assert.equal(decoded.kind, 'Unknown');
    if (decoded.kind === 'Unknown') {
      assert.equal(decoded.service, 0x0c0);
      assert.deepEqual(Array.from(decoded.raw), [0x00, 0xc0]);
    }
  });

  it('returns Unknown for DeviceDescriptorRead (0x300) and Response (0x340)', () => {
    // These appear during programming/management; we don't process them but
    // they shouldn't break CEMI parsing either.
    for (const service of [0x300, 0x340]) {
      const apdu = Buffer.from([(service >> 8) & 0b11, service & 0xff]);
      const decoded = decodeApci(apdu);
      assert.equal(decoded.kind, 'Unknown');
      if (decoded.kind === 'Unknown') assert.equal(decoded.service, service);
    }
  });

  it('rejects short APDUs', () => {
    assert.throws(() => decodeApci(Buffer.from([0x00])), ConversionError);
  });
});

describe('encodeApci/decodeApci round-trip', () => {
  it('round-trips GroupValueWrite small over 0..63', () => {
    for (let v = 0; v < 64; v++) {
      const buf = encodeApci(groupValueWrite(smallValue(v)));
      const back = decodeApci(buf);
      assert.deepEqual(back, { kind: 'GroupValueWrite', data: { kind: 'small', value: v } });
    }
  });

  it('round-trips GroupValueWrite bytes', () => {
    const payload = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
    const buf = encodeApci(groupValueWrite(bytesValue(payload)));
    const back = decodeApci(buf);
    assert.equal(back.kind, 'GroupValueWrite');
    if (back.kind === 'GroupValueWrite' && back.data.kind === 'bytes') {
      assert.deepEqual(Array.from(back.data.value), Array.from(payload));
    }
  });
});

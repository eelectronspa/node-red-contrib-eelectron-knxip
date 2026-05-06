import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ConversionError } from '../../src/core/errors';
import { getDpt, listDpts } from '../../src/dpt';

describe('DPT registry', () => {
  it('returns a codec for known ids', () => {
    const switchCodec = getDpt('1.001');
    assert.equal(switchCodec.id, '1.001');
    assert.equal(switchCodec.name, 'switch');
  });

  it('throws on unknown id', () => {
    assert.throws(() => getDpt('999.999'), ConversionError);
  });

  it('lists the four DPT families', () => {
    const ids = listDpts();
    assert.ok(ids.some((id) => id.startsWith('1.')));
    assert.ok(ids.some((id) => id.startsWith('5.')));
    assert.ok(ids.some((id) => id.startsWith('9.')));
    assert.ok(ids.some((id) => id.startsWith('14.')));
  });
});

describe('DPT 1.* (boolean)', () => {
  it('encodes true → small=1, false → small=0', () => {
    const codec = getDpt('1.001');
    assert.deepEqual(codec.encode(true), { kind: 'small', value: 1 });
    assert.deepEqual(codec.encode(false), { kind: 'small', value: 0 });
  });

  it('decodes small=1 → true, small=0 → false', () => {
    const codec = getDpt('1.001');
    assert.equal(codec.decode({ kind: 'small', value: 1 }), true);
    assert.equal(codec.decode({ kind: 'small', value: 0 }), false);
  });

  it('decodes 1-byte form too', () => {
    const codec = getDpt('1.001');
    assert.equal(codec.decode({ kind: 'bytes', value: Buffer.from([1]) }), true);
    assert.equal(codec.decode({ kind: 'bytes', value: Buffer.from([0]) }), false);
  });

  it('round-trips via switch (1.001) and step (1.007)', () => {
    for (const id of ['1.001', '1.007', '1.008', '1.009']) {
      const codec = getDpt(id);
      for (const v of [true, false]) {
        assert.equal(codec.decode(codec.encode(v)), v);
      }
    }
  });
});

describe('DPT 5.* (8-bit unsigned)', () => {
  it('5.001 percent: 0 → 0%, 255 → 100%', () => {
    const codec = getDpt('5.001');
    assert.equal(codec.decode({ kind: 'bytes', value: Buffer.from([0]) }), 0);
    assert.equal(codec.decode({ kind: 'bytes', value: Buffer.from([0xff]) }), 100);
  });

  it('5.001 percent: encodes 50% → ~127', () => {
    const codec = getDpt('5.001');
    const apdu = codec.encode(50);
    assert.equal(apdu.kind, 'bytes');
    if (apdu.kind === 'bytes') {
      assert.ok(Math.abs(apdu.value[0]! - 128) <= 1);
    }
  });

  it('5.004 raw percent: 0 → 0, 50 → 50', () => {
    const codec = getDpt('5.004');
    assert.equal(codec.decode({ kind: 'bytes', value: Buffer.from([50]) }), 50);
    const apdu = codec.encode(123);
    if (apdu.kind === 'bytes') assert.equal(apdu.value[0], 123);
  });

  it('rejects out-of-range values', () => {
    const codec = getDpt('5.001');
    assert.throws(() => codec.encode(101), ConversionError);
    assert.throws(() => codec.encode(-1), ConversionError);
  });

  it('round-trips 5.001 across the byte range', () => {
    const codec = getDpt('5.001');
    for (let raw = 0; raw <= 255; raw += 17) {
      const apdu: import('../../src/core/apci').APDUValue = {
        kind: 'bytes',
        value: Buffer.from([raw]),
      };
      const value = codec.decode(apdu) as number;
      const back = codec.encode(value);
      if (back.kind === 'bytes') {
        assert.equal(back.value[0], raw);
      }
    }
  });
});

describe('DPT 9.* (2-byte float)', () => {
  it('9.001 temperature: round-trips a range of values within KNX precision', () => {
    const codec = getDpt('9.001');
    // 0x0000 → 0.0
    assert.equal(codec.decode({ kind: 'bytes', value: Buffer.from([0x00, 0x00]) }), 0);
    // KNX 2-byte float resolution is 0.01 * 2^exponent — relative precision ~1%
    // at large magnitudes. Tolerance: 0.01 + 1% of |value|.
    for (const value of [0, 0.01, -0.01, 19.2, -19.2, 21.5, -50, 100, 670760]) {
      const apdu = codec.encode(value);
      const back = codec.decode(apdu) as number;
      const tol = 0.01 + Math.abs(value) * 0.01;
      assert.ok(Math.abs(back - value) <= tol, `expected ${value}, got ${back}`);
    }
  });

  it('9.001 rejects out-of-range', () => {
    const codec = getDpt('9.001');
    assert.throws(() => codec.encode(700_000), ConversionError);
    assert.throws(() => codec.encode(-700_000), ConversionError);
  });

  it('handles negative numbers symmetrically', () => {
    const codec = getDpt('9.002');
    for (const v of [-0.01, -1, -2.5, -100, -1000]) {
      const back = codec.decode(codec.encode(v)) as number;
      const tol = 0.01 + Math.abs(v) * 0.01;
      assert.ok(Math.abs(back - v) <= tol, `expected ${v}, got ${back}`);
    }
  });
});

describe('DPT 14.* (4-byte IEEE float)', () => {
  it('round-trips a range of values', () => {
    const codec = getDpt('14.xxx');
    for (const v of [0, 1.5, -3.14159, 1e20, -1e-20, 12345.6789]) {
      const back = codec.decode(codec.encode(v)) as number;
      // single-precision precision is ~7 digits
      assert.ok(Math.abs(back - v) <= Math.abs(v) * 1e-6 + 1e-30);
    }
  });

  it('rejects non-finite values', () => {
    const codec = getDpt('14.xxx');
    assert.throws(() => codec.encode(Number.NaN), ConversionError);
    assert.throws(() => codec.encode(Number.POSITIVE_INFINITY), ConversionError);
  });
});

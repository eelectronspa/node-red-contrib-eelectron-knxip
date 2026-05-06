import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ConversionError } from '../../src/core/errors';
import { type DPTCodec, getDpt } from '../../src/dpt';
import type { DPT2Value } from '../../src/dpt/dpt2';
import type { DPT3Value } from '../../src/dpt/dpt3';
import type { DPT10Value } from '../../src/dpt/dpt10';
import type { DPT11Value } from '../../src/dpt/dpt11';
import type { DPT18Value } from '../../src/dpt/dpt18';
import type { RGBColor } from '../../src/dpt/dpt232';

describe('DPT 2.* (control + bool)', () => {
  it('round-trips all four combinations', () => {
    const codec = getDpt('2.001') as DPTCodec<DPT2Value>;
    for (const control of [false, true]) {
      for (const value of [false, true]) {
        const back = codec.decode(codec.encode({ control, value }));
        assert.deepEqual(back, { control, value });
      }
    }
  });
});

describe('DPT 3.* (4-bit control)', () => {
  it('round-trips dimming variants', () => {
    const codec = getDpt('3.007') as DPTCodec<DPT3Value>;
    for (const control of [false, true]) {
      for (let stepCode = 0; stepCode <= 7; stepCode++) {
        const back = codec.decode(codec.encode({ control, stepCode }));
        assert.deepEqual(back, { control, stepCode });
      }
    }
  });

  it('rejects out-of-range stepCode', () => {
    const codec = getDpt('3.007') as DPTCodec<DPT3Value>;
    assert.throws(() => codec.encode({ control: true, stepCode: 8 }), ConversionError);
    assert.throws(() => codec.encode({ control: false, stepCode: -1 }), ConversionError);
  });
});

describe('DPT 6.* (signed 8-bit)', () => {
  it('round-trips negative and positive', () => {
    const codec = getDpt('6.001') as DPTCodec<number>;
    for (const v of [-128, -1, 0, 1, 100, 127]) {
      assert.equal(codec.decode(codec.encode(v)), v);
    }
  });
  it('rejects out-of-range', () => {
    const codec = getDpt('6.001') as DPTCodec<number>;
    assert.throws(() => codec.encode(128), ConversionError);
    assert.throws(() => codec.encode(-129), ConversionError);
  });
});

describe('DPT 7.* (uint16)', () => {
  it('round-trips boundary values', () => {
    const codec = getDpt('7.001') as DPTCodec<number>;
    for (const v of [0, 1, 12345, 65535]) {
      assert.equal(codec.decode(codec.encode(v)), v);
    }
  });
  it('rejects negative', () => {
    const codec = getDpt('7.001') as DPTCodec<number>;
    assert.throws(() => codec.encode(-1), ConversionError);
    assert.throws(() => codec.encode(65536), ConversionError);
  });
});

describe('DPT 8.* (int16)', () => {
  it('round-trips negative and positive', () => {
    const codec = getDpt('8.001') as DPTCodec<number>;
    for (const v of [-32768, -1, 0, 12345, 32767]) {
      assert.equal(codec.decode(codec.encode(v)), v);
    }
  });
});

describe('DPT 12.* (uint32)', () => {
  it('round-trips boundary values', () => {
    const codec = getDpt('12.001') as DPTCodec<number>;
    for (const v of [0, 1, 0x7fff_ffff, 0xffff_ffff]) {
      assert.equal(codec.decode(codec.encode(v)), v);
    }
  });
});

describe('DPT 13.* (int32)', () => {
  it('round-trips signed boundary values', () => {
    const codec = getDpt('13.001') as DPTCodec<number>;
    for (const v of [-0x8000_0000, -1, 0, 0x7fff_ffff]) {
      assert.equal(codec.decode(codec.encode(v)), v);
    }
  });
});

describe('DPT 10.001 (time)', () => {
  it('round-trips time with day', () => {
    const codec = getDpt('10.001') as DPTCodec<DPT10Value>;
    const v: DPT10Value = { hour: 13, minutes: 45, seconds: 30, day: 'wednesday' };
    assert.deepEqual(codec.decode(codec.encode(v)), v);
  });

  it('defaults day to no_day on decode of zero day bits', () => {
    const codec = getDpt('10.001') as DPTCodec<DPT10Value>;
    const back = codec.decode(codec.encode({ hour: 0, minutes: 0, seconds: 0 }));
    assert.equal(back.day, 'no_day');
  });

  it('rejects invalid components', () => {
    const codec = getDpt('10.001') as DPTCodec<DPT10Value>;
    assert.throws(() => codec.encode({ hour: 24, minutes: 0, seconds: 0 }), ConversionError);
    assert.throws(() => codec.encode({ hour: 0, minutes: 60, seconds: 0 }), ConversionError);
  });
});

describe('DPT 11.001 (date)', () => {
  it('round-trips a 2000s date', () => {
    const codec = getDpt('11.001') as DPTCodec<DPT11Value>;
    const v: DPT11Value = { year: 2026, month: 5, day: 6 };
    assert.deepEqual(codec.decode(codec.encode(v)), v);
  });

  it('round-trips a 1990s date', () => {
    const codec = getDpt('11.001') as DPTCodec<DPT11Value>;
    const v: DPT11Value = { year: 1995, month: 1, day: 1 };
    assert.deepEqual(codec.decode(codec.encode(v)), v);
  });

  it('rejects out-of-range year', () => {
    const codec = getDpt('11.001') as DPTCodec<DPT11Value>;
    assert.throws(() => codec.encode({ year: 1980, month: 1, day: 1 }), ConversionError);
    assert.throws(() => codec.encode({ year: 2100, month: 1, day: 1 }), ConversionError);
  });
});

describe('DPT 16.* (string)', () => {
  it('encodes ASCII string and round-trips trimmed', () => {
    const codec = getDpt('16.000') as DPTCodec<string>;
    const apdu = codec.encode('Hello');
    assert.equal((apdu as { kind: 'bytes'; value: Buffer }).value.length, 14);
    assert.equal(codec.decode(apdu), 'Hello');
  });

  it('rejects strings longer than 14 bytes', () => {
    const codec = getDpt('16.000') as DPTCodec<string>;
    assert.throws(() => codec.encode('x'.repeat(15)), ConversionError);
  });

  it('Latin-1 supports characters >127', () => {
    const codec = getDpt('16.001') as DPTCodec<string>;
    assert.equal(codec.decode(codec.encode('Café')), 'Café');
  });
});

describe('DPT 17.001 (scene number)', () => {
  it('round-trips 0..63', () => {
    const codec = getDpt('17.001') as DPTCodec<number>;
    for (const v of [0, 1, 31, 63]) {
      assert.equal(codec.decode(codec.encode(v)), v);
    }
  });
  it('rejects out-of-range scene number', () => {
    const codec = getDpt('17.001') as DPTCodec<number>;
    assert.throws(() => codec.encode(64), ConversionError);
    assert.throws(() => codec.encode(-1), ConversionError);
  });
});

describe('DPT 18.001 (scene control)', () => {
  it('round-trips activate and learn', () => {
    const codec = getDpt('18.001') as DPTCodec<DPT18Value>;
    const a: DPT18Value = { control: 'activate', sceneNumber: 5 };
    const l: DPT18Value = { control: 'learn', sceneNumber: 17 };
    assert.deepEqual(codec.decode(codec.encode(a)), a);
    assert.deepEqual(codec.decode(codec.encode(l)), l);
  });
});

describe('DPT 232.600 (RGB)', () => {
  it('round-trips RGB triples', () => {
    const codec = getDpt('232.600') as DPTCodec<RGBColor>;
    for (const v of [
      { red: 0, green: 0, blue: 0 },
      { red: 255, green: 255, blue: 255 },
      { red: 0x6d, green: 0x30, blue: 0x01 },
    ]) {
      assert.deepEqual(codec.decode(codec.encode(v)), v);
    }
  });

  it('rejects out-of-range component', () => {
    const codec = getDpt('232.600') as DPTCodec<RGBColor>;
    assert.throws(
      () => codec.encode({ red: 256, green: 0, blue: 0 }),
      ConversionError,
    );
  });
});

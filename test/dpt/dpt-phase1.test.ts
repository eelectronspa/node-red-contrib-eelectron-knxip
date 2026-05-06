import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ConversionError } from '../../src/core/errors';
import { type DPTCodec, getDpt } from '../../src/dpt';
import type { DPT19Value } from '../../src/dpt/dpt19';
import type { DPT235Value } from '../../src/dpt/dpt235';
import type { RGBWColor } from '../../src/dpt/dpt251';

describe('DPT 4.* (character)', () => {
  it('round-trips ASCII char', () => {
    const codec = getDpt('4.001') as DPTCodec<string>;
    for (const c of ['A', 'z', '0', '~']) {
      assert.equal(codec.decode(codec.encode(c)), c);
    }
  });
  it('rejects multi-character or non-ASCII', () => {
    const codec = getDpt('4.001') as DPTCodec<string>;
    assert.throws(() => codec.encode(''), ConversionError);
    assert.throws(() => codec.encode('AB'), ConversionError);
    // Latin-1 char rejected by ASCII codec
    assert.throws(() => codec.encode('é'), ConversionError);
  });
  it('Latin-1 codec accepts é', () => {
    const codec = getDpt('4.002') as DPTCodec<string>;
    assert.equal(codec.decode(codec.encode('é')), 'é');
  });
});

describe('DPT 19.001 (date+time)', () => {
  it('round-trips a typical timestamp', () => {
    const codec = getDpt('19.001') as DPTCodec<DPT19Value>;
    const v: DPT19Value = {
      year: 2026,
      month: 5,
      day: 6,
      hour: 14,
      minutes: 30,
      seconds: 45,
      dayOfWeek: 'wednesday',
    };
    const back = codec.decode(codec.encode(v));
    assert.equal(back.year, 2026);
    assert.equal(back.month, 5);
    assert.equal(back.day, 6);
    assert.equal(back.hour, 14);
    assert.equal(back.minutes, 30);
    assert.equal(back.seconds, 45);
    assert.equal(back.dayOfWeek, 'wednesday');
  });
  it('encodes flags and clock quality', () => {
    const codec = getDpt('19.001') as DPTCodec<DPT19Value>;
    const back = codec.decode(
      codec.encode({
        year: 2024,
        month: 1,
        day: 1,
        hour: 0,
        minutes: 0,
        seconds: 0,
        summerTime: true,
        clockQuality: 'unsynchronised',
      }),
    );
    assert.equal(back.summerTime, true);
    assert.equal(back.clockQuality, 'unsynchronised');
  });
  it('rejects out-of-range values', () => {
    const codec = getDpt('19.001') as DPTCodec<DPT19Value>;
    assert.throws(
      () =>
        codec.encode({
          year: 1899,
          month: 1,
          day: 1,
          hour: 0,
          minutes: 0,
          seconds: 0,
        }),
      ConversionError,
    );
    assert.throws(
      () =>
        codec.encode({
          year: 2024,
          month: 13,
          day: 1,
          hour: 0,
          minutes: 0,
          seconds: 0,
        }),
      ConversionError,
    );
  });
});

describe('DPT 235.001 (energy + tariff)', () => {
  it('round-trips a typical reading', () => {
    const codec = getDpt('235.001') as DPTCodec<DPT235Value>;
    const v: DPT235Value = {
      energy: 123_456,
      tariff: 2,
      energyValid: true,
      tariffValid: true,
    };
    const back = codec.decode(codec.encode(v));
    assert.equal(back.energy, 123_456);
    assert.equal(back.tariff, 2);
    assert.equal(back.energyValid, true);
    assert.equal(back.tariffValid, true);
  });
  it('handles negative energy', () => {
    const codec = getDpt('235.001') as DPTCodec<DPT235Value>;
    const back = codec.decode(codec.encode({ energy: -500, tariff: 0 }));
    assert.equal(back.energy, -500);
  });
});

describe('DPT 251.600 (RGBW)', () => {
  it('round-trips a colour with all channels valid', () => {
    const codec = getDpt('251.600') as DPTCodec<RGBWColor>;
    const v: RGBWColor = { red: 255, green: 128, blue: 64, white: 200 };
    const back = codec.decode(codec.encode(v));
    assert.equal(back.red, 255);
    assert.equal(back.green, 128);
    assert.equal(back.blue, 64);
    assert.equal(back.white, 200);
    assert.equal(back.validity?.red, true);
  });
  it('honours per-channel validity flags', () => {
    const codec = getDpt('251.600') as DPTCodec<RGBWColor>;
    const back = codec.decode(
      codec.encode({
        red: 1,
        green: 2,
        blue: 3,
        white: 4,
        validity: { red: true, green: false, blue: true, white: false },
      }),
    );
    assert.equal(back.validity?.red, true);
    assert.equal(back.validity?.green, false);
    assert.equal(back.validity?.blue, true);
    assert.equal(back.validity?.white, false);
  });
  it('rejects out-of-range channel value', () => {
    const codec = getDpt('251.600') as DPTCodec<RGBWColor>;
    assert.throws(
      () => codec.encode({ red: 256, green: 0, blue: 0, white: 0 }),
      ConversionError,
    );
  });
});

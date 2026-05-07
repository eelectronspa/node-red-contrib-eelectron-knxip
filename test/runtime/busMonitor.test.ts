import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  BusMonitor,
  DEFAULT_BUFFER_SIZE,
  type TelegramRecord,
} from '../../src/runtime/busMonitor';

function rec(overrides: Partial<TelegramRecord> = {}): TelegramRecord {
  return {
    ts: Date.now(),
    tunnelId: 't1',
    tunnelLabel: 'gw',
    direction: 'in',
    source: '1.1.1',
    destination: '1/2/3',
    apci: 'GroupValueWrite',
    raw: 'aa',
    ...overrides,
  };
}

describe('BusMonitor', () => {
  it('rejects bad maxSize', () => {
    assert.throws(() => new BusMonitor(0));
    assert.throws(() => new BusMonitor(-1));
    assert.throws(() => new BusMonitor(1.5));
  });

  it('default capacity is 500 and starts empty', () => {
    const m = new BusMonitor();
    assert.equal(m.capacity, DEFAULT_BUFFER_SIZE);
    assert.equal(m.size, 0);
    assert.deepEqual(m.recent(), []);
  });

  it('push appends and emits a telegram event', () => {
    const m = new BusMonitor(8);
    const seen: TelegramRecord[] = [];
    m.on('telegram', (r) => seen.push(r));
    const r = rec({ raw: 'ff' });
    m.push(r);
    assert.equal(m.size, 1);
    assert.deepEqual(m.recent(), [r]);
    assert.deepEqual(seen, [r]);
  });

  it('drops oldest record once over capacity', () => {
    const m = new BusMonitor(3);
    for (let i = 0; i < 5; i++) m.push(rec({ raw: i.toString(16).padStart(2, '0') }));
    assert.equal(m.size, 3);
    assert.deepEqual(
      m.recent().map((r) => r.raw),
      ['02', '03', '04'],
    );
  });

  it('recent(limit) returns the latest N entries', () => {
    const m = new BusMonitor(10);
    for (let i = 0; i < 6; i++) m.push(rec({ raw: i.toString() }));
    assert.deepEqual(
      m.recent(3).map((r) => r.raw),
      ['3', '4', '5'],
    );
    assert.deepEqual(m.recent(0), []);
  });

  it('clear empties the buffer and emits cleared', () => {
    const m = new BusMonitor();
    m.push(rec());
    let cleared = false;
    m.on('cleared', () => {
      cleared = true;
    });
    m.clear();
    assert.equal(m.size, 0);
    assert.equal(cleared, true);
  });

  it('recent() returns a copy — caller mutation does not corrupt buffer', () => {
    const m = new BusMonitor();
    m.push(rec({ raw: 'aa' }));
    const out = m.recent();
    out.push(rec({ raw: 'bb' }));
    assert.equal(m.size, 1);
    assert.equal(m.recent().length, 1);
  });
});

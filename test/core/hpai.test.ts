import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { CouldNotParseKNXIP } from '../../src/core/errors';
import { HPAI } from '../../src/core/hpai';
import { HostProtocol } from '../../src/core/serviceTypes';

describe('HPAI', () => {
  it('serializes a UDP endpoint', () => {
    const h = new HPAI('192.168.1.10', 3671, HostProtocol.IPV4_UDP);
    const buf = h.toKnx();
    assert.deepEqual(
      Array.from(buf),
      [0x08, 0x01, 192, 168, 1, 10, (3671 >> 8) & 0xff, 3671 & 0xff],
    );
  });

  it('round-trips through bytes', () => {
    const h = new HPAI('10.0.0.5', 50100, HostProtocol.IPV4_TCP);
    const { hpai, bytesRead } = HPAI.fromKnx(h.toKnx());
    assert.equal(bytesRead, 8);
    assert.equal(hpai.ip, h.ip);
    assert.equal(hpai.port, h.port);
    assert.equal(hpai.protocol, HostProtocol.IPV4_TCP);
  });

  it('detects route-back form', () => {
    const h = HPAI.routeBack();
    assert.equal(h.isRouteBack, true);
    const back = HPAI.fromKnx(h.toKnx()).hpai;
    assert.equal(back.isRouteBack, true);
  });

  it('rejects malformed IP at construction', () => {
    assert.throws(() => new HPAI('999.0.0.1', 0));
    assert.throws(() => new HPAI('not.an.ip', 0));
  });

  it('rejects out-of-range port', () => {
    assert.throws(() => new HPAI('1.2.3.4', -1));
    assert.throws(() => new HPAI('1.2.3.4', 65536));
  });

  it('rejects buffer with wrong length byte', () => {
    const buf = Buffer.from([0x07, 0x01, 1, 2, 3, 4, 0x0e, 0x57]);
    assert.throws(() => HPAI.fromKnx(buf), CouldNotParseKNXIP);
  });

  it('rejects unsupported protocol code', () => {
    const buf = Buffer.from([0x08, 0x09, 1, 2, 3, 4, 0x0e, 0x57]);
    assert.throws(() => HPAI.fromKnx(buf), CouldNotParseKNXIP);
  });
});

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { CouldNotParseKNXIP, IncompleteKNXIPFrame } from '../../src/core/errors';
import { KNXIPHeader } from '../../src/core/knxipHeader';
import { ServiceType } from '../../src/core/serviceTypes';

describe('KNXIPHeader', () => {
  it('serializes a CONNECT_REQUEST header', () => {
    const header = new KNXIPHeader(ServiceType.CONNECT_REQUEST, 26);
    const buf = header.toKnx();
    assert.deepEqual(Array.from(buf), [0x06, 0x10, 0x02, 0x05, 0x00, 0x1a]);
  });

  it('round-trips through bytes', () => {
    const header = new KNXIPHeader(ServiceType.TUNNELLING_REQUEST, 0x0123);
    const { header: parsed, bytesRead } = KNXIPHeader.fromKnx(header.toKnx());
    assert.equal(bytesRead, 6);
    assert.equal(parsed.serviceType, ServiceType.TUNNELLING_REQUEST);
    assert.equal(parsed.totalLength, 0x0123);
  });

  it('throws on short buffer', () => {
    assert.throws(() => KNXIPHeader.fromKnx(Buffer.from([0x06, 0x10, 0x02])), IncompleteKNXIPFrame);
  });

  it('throws on wrong header length byte', () => {
    const buf = Buffer.from([0x05, 0x10, 0x02, 0x05, 0x00, 0x06]);
    assert.throws(() => KNXIPHeader.fromKnx(buf), CouldNotParseKNXIP);
  });

  it('throws on wrong protocol version', () => {
    const buf = Buffer.from([0x06, 0x11, 0x02, 0x05, 0x00, 0x06]);
    assert.throws(() => KNXIPHeader.fromKnx(buf), CouldNotParseKNXIP);
  });
});

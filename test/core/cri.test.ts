import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { CRD, CRI } from '../../src/core/cri';
import { ConnectionType, TunnellingLayer } from '../../src/core/serviceTypes';

describe('CRI', () => {
  it('serializes a basic tunnel CRI (4 bytes)', () => {
    const cri = new CRI({ knxLayer: TunnellingLayer.DATA_LINK_LAYER });
    assert.deepEqual(Array.from(cri.toKnx()), [0x04, 0x04, 0x02, 0x00]);
  });

  it('serializes an extended tunnel CRI (6 bytes)', () => {
    const cri = new CRI({ individualAddress: '1.1.5' });
    const buf = cri.toKnx();
    assert.equal(buf.length, 6);
    assert.equal(buf[0], 0x06);
    assert.equal(buf.readUInt16BE(4), (1 << 12) | (1 << 8) | 5);
  });

  it('round-trips basic tunnel', () => {
    const cri = new CRI();
    const { cri: parsed } = CRI.fromKnx(cri.toKnx());
    assert.equal(parsed.connectionType, ConnectionType.TUNNEL_CONNECTION);
    assert.equal(parsed.knxLayer, TunnellingLayer.DATA_LINK_LAYER);
    assert.equal(parsed.individualAddress, null);
  });

  it('round-trips extended tunnel', () => {
    const cri = new CRI({ individualAddress: '15.15.255' });
    const { cri: parsed } = CRI.fromKnx(cri.toKnx());
    assert.equal(parsed.individualAddress?.toString(), '15.15.255');
  });
});

describe('CRD', () => {
  it('serializes a tunnel CRD with individual address', () => {
    const crd = new CRD({ individualAddress: '1.1.10' });
    const buf = crd.toKnx();
    assert.equal(buf.length, 4);
    assert.equal(buf[0], 0x04);
    assert.equal(buf[1], ConnectionType.TUNNEL_CONNECTION);
    assert.equal(buf.readUInt16BE(2), (1 << 12) | (1 << 8) | 10);
  });

  it('round-trips through bytes', () => {
    const crd = new CRD({ individualAddress: '2.3.4' });
    const { crd: parsed } = CRD.fromKnx(crd.toKnx());
    assert.equal(parsed.individualAddress?.toString(), '2.3.4');
  });
});

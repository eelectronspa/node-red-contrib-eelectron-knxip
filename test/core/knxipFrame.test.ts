import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  ConnectionStateRequest,
  ConnectionStateResponse,
  TunnellingAck,
  TunnellingRequest,
} from '../../src/core/bodies';
import { UnsupportedKNXIPService } from '../../src/core/errors';
import { KNXIPFrame } from '../../src/core/knxipFrame';
import { ServiceType } from '../../src/core/serviceTypes';

describe('KNXIPFrame', () => {
  it('builds a frame around a TunnellingAck and round-trips', () => {
    const ack = new TunnellingAck({ communicationChannelId: 3, sequenceCounter: 42 });
    const frame = KNXIPFrame.fromBody(ack);
    assert.equal(frame.header.serviceType, ServiceType.TUNNELLING_ACK);
    assert.equal(frame.header.totalLength, 6 + 4); // header + body
    const buf = frame.toKnx();
    assert.equal(buf.length, 10);
    const { frame: parsed, bytesRead } = KNXIPFrame.fromKnx(buf);
    assert.equal(bytesRead, 10);
    assert.equal(parsed.header.serviceType, ServiceType.TUNNELLING_ACK);
    assert.ok(parsed.body instanceof TunnellingAck);
  });

  it('round-trips a TunnellingRequest with embedded CEMI bytes', () => {
    const cemi = Buffer.from([0x29, 0x00, 0xbc, 0xe0, 0x11, 0x05, 0x09, 0x01, 0x01, 0x00, 0x81]);
    const req = new TunnellingRequest({
      communicationChannelId: 7,
      sequenceCounter: 5,
      rawCemi: cemi,
    });
    const buf = KNXIPFrame.fromBody(req).toKnx();
    const { frame: parsed } = KNXIPFrame.fromKnx(buf);
    assert.ok(parsed.body instanceof TunnellingRequest);
    assert.equal((parsed.body as TunnellingRequest).sequenceCounter, 5);
  });

  it('round-trips ConnectionStateRequest/Response', () => {
    const req = new ConnectionStateRequest({ communicationChannelId: 9 });
    const reqBuf = KNXIPFrame.fromBody(req).toKnx();
    const parsedReq = KNXIPFrame.fromKnx(reqBuf).frame.body;
    assert.ok(parsedReq instanceof ConnectionStateRequest);

    const resp = new ConnectionStateResponse({ communicationChannelId: 9 });
    const respBuf = KNXIPFrame.fromBody(resp).toKnx();
    const parsedResp = KNXIPFrame.fromKnx(respBuf).frame.body;
    assert.ok(parsedResp instanceof ConnectionStateResponse);
  });

  it('throws UnsupportedKNXIPService on unknown service type', () => {
    // Build a header-only buffer with an unsupported service type (DESCRIPTION_REQUEST = 0x0203)
    const buf = Buffer.from([0x06, 0x10, 0x02, 0x03, 0x00, 0x06]);
    assert.throws(() => KNXIPFrame.fromKnx(buf), UnsupportedKNXIPService);
  });
});

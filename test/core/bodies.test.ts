import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  ConnectRequest,
  ConnectResponse,
  ConnectionStateRequest,
  ConnectionStateResponse,
  DisconnectRequest,
  DisconnectResponse,
  TunnellingAck,
  TunnellingRequest,
} from '../../src/core/bodies';
import { CRD } from '../../src/core/cri';
import { CouldNotParseKNXIP } from '../../src/core/errors';
import { HPAI } from '../../src/core/hpai';
import { ErrorCode, HostProtocol } from '../../src/core/serviceTypes';

describe('ConnectRequest', () => {
  it('round-trips with route-back HPAIs and basic CRI', () => {
    const original = new ConnectRequest();
    const buf = original.toKnx();
    // 8 + 8 + 4 = 20 bytes
    assert.equal(buf.length, 20);
    const { body, bytesRead } = ConnectRequest.fromKnx(buf);
    assert.equal(bytesRead, 20);
    assert.equal(body.controlEndpoint.isRouteBack, true);
    assert.equal(body.dataEndpoint.isRouteBack, true);
    assert.equal(body.cri.calculatedLength(), 4);
  });

  it('round-trips with explicit endpoints and extended CRI', () => {
    const original = new ConnectRequest({
      controlEndpoint: new HPAI('192.168.1.10', 50100, HostProtocol.IPV4_UDP),
      dataEndpoint: new HPAI('192.168.1.10', 50101, HostProtocol.IPV4_UDP),
      cri: { individualAddress: '1.1.50' },
    });
    const buf = original.toKnx();
    assert.equal(buf.length, 8 + 8 + 6);
    const { body } = ConnectRequest.fromKnx(buf);
    assert.equal(body.controlEndpoint.port, 50100);
    assert.equal(body.cri.individualAddress?.toString(), '1.1.50');
  });
});

describe('ConnectResponse', () => {
  it('round-trips a successful response', () => {
    const original = new ConnectResponse({
      communicationChannelId: 1,
      dataEndpoint: new HPAI('10.0.0.5', 3671),
      crd: new CRD({ individualAddress: '15.15.250' }),
    });
    const buf = original.toKnx();
    const { body } = ConnectResponse.fromKnx(buf);
    assert.equal(body.communicationChannelId, 1);
    assert.equal(body.statusCode, ErrorCode.E_NO_ERROR);
    assert.equal(body.dataEndpoint.ip, '10.0.0.5');
    assert.equal(body.crd.individualAddress?.toString(), '15.15.250');
  });

  it('round-trips an error response (status only, no HPAI/CRD)', () => {
    const original = new ConnectResponse({
      communicationChannelId: 7,
      statusCode: ErrorCode.E_NO_MORE_CONNECTIONS,
    });
    const buf = original.toKnx();
    assert.equal(buf.length, 2);
    const { body, bytesRead } = ConnectResponse.fromKnx(buf);
    assert.equal(bytesRead, 2);
    assert.equal(body.statusCode, ErrorCode.E_NO_MORE_CONNECTIONS);
  });
});

describe('ConnectionStateRequest', () => {
  it('round-trips', () => {
    const original = new ConnectionStateRequest({ communicationChannelId: 5 });
    const buf = original.toKnx();
    assert.equal(buf.length, 10);
    const { body, bytesRead } = ConnectionStateRequest.fromKnx(buf);
    assert.equal(bytesRead, 10);
    assert.equal(body.communicationChannelId, 5);
  });
});

describe('ConnectionStateResponse', () => {
  it('round-trips with non-error status', () => {
    const original = new ConnectionStateResponse({
      communicationChannelId: 5,
      statusCode: ErrorCode.E_NO_ERROR,
    });
    const buf = original.toKnx();
    assert.deepEqual(Array.from(buf), [5, 0]);
    const { body } = ConnectionStateResponse.fromKnx(buf);
    assert.equal(body.statusCode, ErrorCode.E_NO_ERROR);
  });
});

describe('DisconnectRequest / Response', () => {
  it('round-trips', () => {
    const req = new DisconnectRequest({ communicationChannelId: 7 });
    const reqBuf = req.toKnx();
    assert.equal(reqBuf.length, 10);
    assert.equal(DisconnectRequest.fromKnx(reqBuf).body.communicationChannelId, 7);

    const resp = new DisconnectResponse({ communicationChannelId: 7 });
    assert.equal(resp.toKnx().length, 2);
  });
});

describe('TunnellingRequest', () => {
  it('round-trips with raw CEMI bytes', () => {
    const cemi = Buffer.from([0x29, 0x00, 0xbc, 0xe0, 0x00, 0x00, 0x09, 0x01, 0x01, 0x00, 0x81]);
    const original = new TunnellingRequest({
      communicationChannelId: 3,
      sequenceCounter: 42,
      rawCemi: cemi,
    });
    const buf = original.toKnx();
    assert.equal(buf[0], 0x04); // struct length
    assert.equal(buf[1], 3);
    assert.equal(buf[2], 42);
    assert.equal(buf[3], 0x00); // reserved
    assert.equal(buf.length, 4 + cemi.length);

    const { body } = TunnellingRequest.fromKnx(buf);
    assert.equal(body.sequenceCounter, 42);
    assert.deepEqual(Array.from(body.rawCemi), Array.from(cemi));
  });

  it('wraps sequence counter at 0xff', () => {
    const t = new TunnellingRequest({
      communicationChannelId: 0,
      sequenceCounter: 0x100,
      rawCemi: Buffer.alloc(0),
    });
    assert.equal(t.sequenceCounter, 0);
  });

  it('rejects wrong struct length byte', () => {
    const bad = Buffer.from([0x05, 0x00, 0x00, 0x00]);
    assert.throws(() => TunnellingRequest.fromKnx(bad), CouldNotParseKNXIP);
  });
});

describe('TunnellingAck', () => {
  it('round-trips', () => {
    const original = new TunnellingAck({ communicationChannelId: 3, sequenceCounter: 42 });
    const buf = original.toKnx();
    assert.deepEqual(Array.from(buf), [0x04, 3, 42, 0]);
    const { body } = TunnellingAck.fromKnx(buf);
    assert.equal(body.communicationChannelId, 3);
    assert.equal(body.sequenceCounter, 42);
    assert.equal(body.statusCode, ErrorCode.E_NO_ERROR);
  });
});

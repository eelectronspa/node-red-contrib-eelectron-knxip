import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { IndividualAddress } from '../../src/core/address';
import {
  SearchRequest,
  SearchResponse,
} from '../../src/core/bodies';
import type { DeviceInfoDIB } from '../../src/core/bodies/searchResponse';
import { HPAI } from '../../src/core/hpai';
import { KNXIPFrame } from '../../src/core/knxipFrame';
import { ServiceType } from '../../src/core/serviceTypes';

describe('SearchRequest', () => {
  it('round-trips a route-back HPAI body', () => {
    const req = new SearchRequest();
    const buf = req.toKnx();
    assert.equal(buf.length, 8);
    const { body } = SearchRequest.fromKnx(buf);
    assert.equal(body.controlEndpoint.isRouteBack, true);
  });

  it('round-trips through KNXIPFrame', () => {
    const frame = KNXIPFrame.fromBody(new SearchRequest());
    assert.equal(frame.header.serviceType, ServiceType.SEARCH_REQUEST);
    const buf = frame.toKnx();
    const { frame: parsed } = KNXIPFrame.fromKnx(buf);
    assert.ok(parsed.body instanceof SearchRequest);
  });
});

describe('SearchResponse', () => {
  it('parses a synthesized response with device-info DIB', () => {
    const di: DeviceInfoDIB = {
      knxMedium: 0x02,
      deviceStatus: 0x00,
      individualAddress: new IndividualAddress('1.1.0'),
      projectInstallation: 0,
      serial: '0123456789ab',
      multicastAddress: '224.0.23.12',
      macAddress: 'aa:bb:cc:dd:ee:ff',
      friendlyName: 'Test Gateway',
    };
    const original = new SearchResponse({
      controlEndpoint: new HPAI('192.168.1.10', 3671),
      deviceInfo: di,
    });
    const frame = KNXIPFrame.fromBody(original);
    const buf = frame.toKnx();
    const { frame: parsed } = KNXIPFrame.fromKnx(buf);
    assert.ok(parsed.body instanceof SearchResponse);
    const body = parsed.body as SearchResponse;
    assert.equal(body.controlEndpoint.ip, '192.168.1.10');
    assert.equal(body.controlEndpoint.port, 3671);
    assert.ok(body.deviceInfo, 'device info should be parsed');
    assert.equal(body.deviceInfo!.friendlyName, 'Test Gateway');
    assert.equal(body.deviceInfo!.individualAddress.toString(), '1.1.0');
    assert.equal(body.deviceInfo!.multicastAddress, '224.0.23.12');
    assert.equal(body.deviceInfo!.macAddress, 'aa:bb:cc:dd:ee:ff');
    assert.equal(body.deviceInfo!.serial, '0123456789ab');
  });

  it('tolerates a response with no device-info DIB', () => {
    const original = new SearchResponse({
      controlEndpoint: new HPAI('10.0.0.1', 3671),
      deviceInfo: null,
    });
    const buf = KNXIPFrame.fromBody(original).toKnx();
    const { frame: parsed } = KNXIPFrame.fromKnx(buf);
    assert.ok(parsed.body instanceof SearchResponse);
    const body = parsed.body as SearchResponse;
    assert.equal(body.deviceInfo, null);
    assert.equal(body.controlEndpoint.ip, '10.0.0.1');
  });
});

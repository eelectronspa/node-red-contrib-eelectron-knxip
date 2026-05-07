import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { groupValueWrite, smallValue } from '../../src/core/apci';
import {
  TunnellingRequest,
} from '../../src/core/bodies';
import { CEMIFlags, CEMIFrame, CEMILData, CEMIMessageCode, DEFAULT_OUTGOING_FLAGS } from '../../src/core/cemi';
import { GroupAddress, IndividualAddress } from '../../src/core/address';
import { KNXIPFrame } from '../../src/core/knxipFrame';
import { tDataGroup } from '../../src/core/tpci';
import { TunnelClient } from '../../src/io/tunnel';
import { MockTransport } from './mockTransport';

function buildClient(): { client: TunnelClient; transport: MockTransport } {
  const transport = new MockTransport();
  const client = new TunnelClient(
    {
      gatewayIp: '192.168.1.10',
      autoReconnect: false,
      heartbeatIntervalMs: 60_000_000,
    },
    // biome-ignore lint/suspicious/noExplicitAny: factory contract
    () => transport as any,
  );
  return { client, transport };
}

function incomingFrame(channelId: number, seq: number): KNXIPFrame {
  const cemi = new CEMIFrame({
    code: CEMIMessageCode.L_DATA_IND,
    data: new CEMILData({
      flags:
        DEFAULT_OUTGOING_FLAGS |
        CEMIFlags.DESTINATION_GROUP_ADDRESS |
        CEMIFlags.PRIORITY_LOW,
      srcAddr: new IndividualAddress('1.1.5'),
      dstAddr: new GroupAddress('1/2/3'),
      tpci: tDataGroup(),
      payload: groupValueWrite(smallValue(1)),
    }),
  });
  return KNXIPFrame.fromBody(
    new TunnellingRequest({
      communicationChannelId: channelId,
      sequenceCounter: seq,
      rawCemi: cemi.toKnx(),
    }),
  );
}

describe('TunnelClient.getDiagnostics', () => {
  it('starts with zero counters and disconnected state', () => {
    const { client } = buildClient();
    const d = client.getDiagnostics();
    assert.equal(d.state, 'disconnected');
    assert.equal(d.txTelegrams, 0);
    assert.equal(d.rxTelegrams, 0);
    assert.equal(d.heartbeatsOk, 0);
    assert.equal(d.heartbeatsFailed, 0);
    assert.equal(d.reconnects, 0);
    assert.equal(d.lastFrameTs, null);
    assert.equal(d.connectedAtTs, null);
    assert.equal(d.uptimeMs, 0);
    assert.equal(d.sinceLastFrameMs, null);
  });

  it('records connectedAtTs + transitions to connected on connect()', async () => {
    const { client, transport } = buildClient();
    const cp = client.connect();
    await Promise.resolve();
    await Promise.resolve();
    transport.injectConnectResponse({ channelId: 5, assignedAddress: '1.1.99' });
    await cp;

    const d = client.getDiagnostics();
    assert.equal(d.state, 'connected');
    assert.equal(d.assignedAddress, '1.1.99');
    assert.ok(d.connectedAtTs !== null);
    assert.ok(d.uptimeMs >= 0);
  });

  it('increments rxTelegrams + lastRxTs on inbound TUNNELLING_REQUEST', async () => {
    const { client, transport } = buildClient();
    const cp = client.connect();
    await Promise.resolve();
    await Promise.resolve();
    transport.injectConnectResponse({ channelId: 5 });
    await cp;

    transport.inject(incomingFrame(5, 0));
    await Promise.resolve();

    const d = client.getDiagnostics();
    assert.equal(d.rxTelegrams, 1);
    assert.ok(d.lastRxTs !== null);
    assert.ok(d.lastFrameTs !== null);
  });

  it('increments txTelegrams + lastTxTs on successful sendCemi', async () => {
    const { client, transport } = buildClient();
    const cp = client.connect();
    await Promise.resolve();
    await Promise.resolve();
    transport.injectConnectResponse({ channelId: 5 });
    await cp;

    const sp = client.groupValueWrite('1/2/3', smallValue(1));
    await Promise.resolve();
    await Promise.resolve();
    transport.ackLast();
    await sp;

    const d = client.getDiagnostics();
    assert.equal(d.txTelegrams, 1);
    assert.ok(d.lastTxTs !== null);
    assert.ok(d.lastFrameTs !== null);
  });

  it('reports tcp / secure flags from options', () => {
    const transport = new MockTransport();
    const client = new TunnelClient(
      {
        gatewayIp: '192.168.1.10',
        autoReconnect: false,
        heartbeatIntervalMs: 60_000_000,
        transport: 'tcp',
        secure: { userId: 2, deviceAuthPassword: 'a', userPassword: 'b' },
      },
      // biome-ignore lint/suspicious/noExplicitAny: factory contract
      () => transport as any,
    );
    const d = client.getDiagnostics();
    assert.equal(d.transport, 'tcp');
    assert.equal(d.secure, true);
  });

  it('rxTelegrams accumulate across multiple inbound frames', async () => {
    const { client, transport } = buildClient();
    const cp = client.connect();
    await Promise.resolve();
    await Promise.resolve();
    transport.injectConnectResponse({ channelId: 5 });
    await cp;

    transport.inject(incomingFrame(5, 0));
    await Promise.resolve();
    transport.inject(incomingFrame(5, 1));
    await Promise.resolve();
    transport.inject(incomingFrame(5, 2));
    await Promise.resolve();

    const d = client.getDiagnostics();
    assert.equal(d.rxTelegrams, 3);
  });
});

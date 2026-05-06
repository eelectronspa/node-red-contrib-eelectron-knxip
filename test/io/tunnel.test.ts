import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { groupValueWrite, smallValue } from '../../src/core/apci';
import {
  ConnectRequest,
  ConnectionStateRequest,
  DisconnectRequest,
  TunnellingAck,
  TunnellingRequest,
} from '../../src/core/bodies';
import { CEMIFlags, CEMIFrame, CEMILData, CEMIMessageCode, DEFAULT_OUTGOING_FLAGS } from '../../src/core/cemi';
import { GroupAddress, IndividualAddress } from '../../src/core/address';
import { KNXIPFrame } from '../../src/core/knxipFrame';
import { ErrorCode, ServiceType } from '../../src/core/serviceTypes';
import { tDataGroup } from '../../src/core/tpci';
import { CommunicationError, TunnelClient } from '../../src/io/tunnel';
import { MockTransport } from './mockTransport';

function buildClient(
  options: { gatewayIp?: string; autoReconnect?: boolean; heartbeatIntervalMs?: number } = {},
): { client: TunnelClient; transport: MockTransport } {
  const transport = new MockTransport();
  const client = new TunnelClient(
    {
      gatewayIp: options.gatewayIp ?? '192.168.1.10',
      autoReconnect: options.autoReconnect ?? false,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 60_000_000,
    },
    // factory ignores opts in tests because we always return the prepared mock
    // biome-ignore lint/suspicious/noExplicitAny: the mock satisfies the surface
    () => transport as any,
  );
  return { client, transport };
}

function makeIncomingTunnellingRequest(
  channelId: number,
  seq: number,
  ga = new GroupAddress('1/2/3'),
): KNXIPFrame {
  const cemi = new CEMIFrame({
    code: CEMIMessageCode.L_DATA_IND,
    data: new CEMILData({
      flags:
        DEFAULT_OUTGOING_FLAGS |
        CEMIFlags.DESTINATION_GROUP_ADDRESS |
        CEMIFlags.PRIORITY_LOW,
      srcAddr: new IndividualAddress('1.1.5'),
      dstAddr: ga,
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

describe('TunnelClient.connect', () => {
  it('happy path — sends CONNECT_REQUEST and transitions to connected', async () => {
    const { client, transport } = buildClient();

    const states: string[] = [];
    client.on('state', (s) => states.push(s));

    const connectPromise = client.connect();
    // The CONNECT_REQUEST should be sent synchronously after bind resolves —
    // give it one tick.
    await Promise.resolve();
    await Promise.resolve();

    const sentReq = transport.sent.find((s) => s.frame.body instanceof ConnectRequest);
    assert.ok(sentReq, 'CONNECT_REQUEST should have been sent');

    transport.injectConnectResponse({ channelId: 7, assignedAddress: '1.1.99' });
    await connectPromise;

    assert.equal(client.state, 'connected');
    assert.equal(client.assignedAddress?.toString(), '1.1.99');
    assert.deepEqual(states, ['connecting', 'connected']);
  });

  it('rejects on non-zero CONNECT_RESPONSE status', async () => {
    const { client, transport } = buildClient();
    const connectPromise = client.connect();
    await Promise.resolve();
    await Promise.resolve();
    transport.injectConnectResponse({ statusCode: ErrorCode.E_NO_MORE_CONNECTIONS });
    await assert.rejects(connectPromise, CommunicationError);
    assert.equal(client.state, 'disconnected');
  });
});

describe('TunnelClient.sendCemi', () => {
  it('sends and resolves on ACK', async () => {
    const { client, transport } = buildClient();
    const cp = client.connect();
    await Promise.resolve();
    await Promise.resolve();
    transport.injectConnectResponse({ channelId: 5 });
    await cp;

    const sendPromise = client.groupValueWrite('1/2/3', smallValue(1));
    await Promise.resolve();
    await Promise.resolve();
    const reqs = transport.sent.filter((s) => s.frame.body instanceof TunnellingRequest);
    assert.equal(reqs.length, 1, 'one TUNNELLING_REQUEST sent');
    const tr = reqs[0]!.frame.body as TunnellingRequest;
    assert.equal(tr.communicationChannelId, 5);
    assert.equal(tr.sequenceCounter, 0);

    transport.ackLast();
    await sendPromise;
  });

  it('serialises concurrent sends and increments sequence', async () => {
    const { client, transport } = buildClient();
    const cp = client.connect();
    await Promise.resolve();
    await Promise.resolve();
    transport.injectConnectResponse({ channelId: 3 });
    await cp;

    const p1 = client.groupValueWrite('1/2/3', smallValue(1));
    const p2 = client.groupValueWrite('1/2/4', smallValue(0));

    // Drain microtasks so the first send is scheduled
    await Promise.resolve();
    await Promise.resolve();

    let reqs = transport.sent.filter((s) => s.frame.body instanceof TunnellingRequest);
    assert.equal(reqs.length, 1, 'second send should not start until first ACKed');
    transport.ackLast();
    await p1;

    await Promise.resolve();
    await Promise.resolve();
    reqs = transport.sent.filter((s) => s.frame.body instanceof TunnellingRequest);
    assert.equal(reqs.length, 2);
    assert.equal((reqs[1]!.frame.body as TunnellingRequest).sequenceCounter, 1);
    transport.ackLast();
    await p2;
  });
});

describe('TunnelClient inbound TUNNELLING_REQUEST', () => {
  it('ACKs and emits cemi on in-order frame', async () => {
    const { client, transport } = buildClient();
    const cp = client.connect();
    await Promise.resolve();
    await Promise.resolve();
    transport.injectConnectResponse({ channelId: 5 });
    await cp;

    const cemiEvents: CEMIFrame[] = [];
    client.on('cemi', (c) => cemiEvents.push(c));

    transport.inject(makeIncomingTunnellingRequest(5, 0));
    await Promise.resolve();

    const acks = transport.sent.filter((s) => s.frame.body instanceof TunnellingAck);
    assert.equal(acks.length, 1);
    assert.equal((acks[0]!.frame.body as TunnellingAck).sequenceCounter, 0);
    assert.equal(cemiEvents.length, 1);
  });

  it('ACKs duplicate (seq-1) but does not re-emit', async () => {
    const { client, transport } = buildClient();
    const cp = client.connect();
    await Promise.resolve();
    await Promise.resolve();
    transport.injectConnectResponse({ channelId: 5 });
    await cp;

    const cemiEvents: CEMIFrame[] = [];
    client.on('cemi', (c) => cemiEvents.push(c));

    // First in-order frame at seq 0
    transport.inject(makeIncomingTunnellingRequest(5, 0));
    await Promise.resolve();
    // Replay the same seq 0 (now expected is 1)
    transport.inject(makeIncomingTunnellingRequest(5, 0));
    await Promise.resolve();

    const acks = transport.sent.filter((s) => s.frame.body instanceof TunnellingAck);
    assert.equal(acks.length, 2, 'duplicate is still ACKed');
    assert.equal(cemiEvents.length, 1, 'duplicate is not re-emitted');
  });
});

describe('TunnelClient inbound DISCONNECT_REQUEST', () => {
  it('ACKs and tears down the tunnel', async () => {
    const { client, transport } = buildClient();
    const cp = client.connect();
    await Promise.resolve();
    await Promise.resolve();
    transport.injectConnectResponse({ channelId: 8 });
    await cp;
    assert.equal(client.state, 'connected');

    const warnings: Error[] = [];
    client.on('warning', (e) => warnings.push(e));
    // autoReconnect=false makes _onTunnelLost emit 'error' — capture it so the
    // EventEmitter doesn't re-throw.
    client.on('error', () => {});

    transport.inject(
      KNXIPFrame.fromBody(
        new DisconnectRequest({ communicationChannelId: 8 }),
      ),
    );
    // Allow the async send of DisconnectResponse to enqueue
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(client.state, 'disconnected');
    assert.equal(warnings.length, 1);

    const sentResponses = transport.sent.filter(
      (s) => s.frame.header.serviceType === ServiceType.DISCONNECT_RESPONSE,
    );
    assert.equal(sentResponses.length, 1);
  });
});

describe('TunnelClient.disconnect', () => {
  it('sends DISCONNECT_REQUEST and tears down', async () => {
    const { client, transport } = buildClient();
    const cp = client.connect();
    await Promise.resolve();
    await Promise.resolve();
    transport.injectConnectResponse({ channelId: 4 });
    await cp;

    const dp = client.disconnect();
    await Promise.resolve();
    await Promise.resolve();

    const dreq = transport.sent.find((s) => s.frame.body instanceof DisconnectRequest);
    assert.ok(dreq, 'DISCONNECT_REQUEST should have been sent');

    transport.injectDisconnectResponse(4);
    await dp;
    assert.equal(client.state, 'disconnected');
  });
});

describe('TunnelClient multi-tunnel', () => {
  it('two clients with separate gateways do not interfere', async () => {
    // Client A
    const transA = new MockTransport();
    transA.bound = { address: '127.0.0.1', port: 50001 };
    const clientA = new TunnelClient(
      { gatewayIp: '10.0.0.1', autoReconnect: false, heartbeatIntervalMs: 60_000_000 },
      // biome-ignore lint/suspicious/noExplicitAny: mock satisfies surface
      () => transA as any,
    );

    // Client B
    const transB = new MockTransport();
    transB.bound = { address: '127.0.0.1', port: 50002 };
    const clientB = new TunnelClient(
      { gatewayIp: '10.0.0.2', autoReconnect: false, heartbeatIntervalMs: 60_000_000 },
      // biome-ignore lint/suspicious/noExplicitAny: mock satisfies surface
      () => transB as any,
    );

    const cpA = clientA.connect();
    const cpB = clientB.connect();
    await Promise.resolve();
    await Promise.resolve();
    transA.injectConnectResponse({ channelId: 1, assignedAddress: '1.1.10' });
    transB.injectConnectResponse({ channelId: 2, assignedAddress: '1.1.20' });
    await cpA;
    await cpB;

    assert.equal(clientA.assignedAddress?.toString(), '1.1.10');
    assert.equal(clientB.assignedAddress?.toString(), '1.1.20');

    // Send on A; B should see nothing.
    const wA = clientA.groupValueWrite('1/2/3', smallValue(1));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(
      transA.sent.filter((s) => s.frame.body instanceof TunnellingRequest).length,
      1,
    );
    assert.equal(
      transB.sent.filter((s) => s.frame.body instanceof TunnellingRequest).length,
      0,
    );
    transA.ackLast();
    await wA;
  });
});

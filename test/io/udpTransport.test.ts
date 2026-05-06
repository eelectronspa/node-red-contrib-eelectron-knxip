import dgram from 'node:dgram';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { TunnellingAck } from '../../src/core/bodies';
import { KNXIPFrame } from '../../src/core/knxipFrame';
import { UdpTransport } from '../../src/io/udpTransport';

function once<T>(emitter: NodeJS.EventEmitter, event: string): Promise<T> {
  return new Promise((resolve) => emitter.once(event, (...args) => resolve(args as unknown as T)));
}

describe('UdpTransport', () => {
  it('round-trips a frame over loopback', async () => {
    // Server-side: a plain dgram socket on a free port.
    const server = dgram.createSocket('udp4');
    await new Promise<void>((resolve) => server.bind(0, '127.0.0.1', resolve));
    const serverPort = (server.address() as { port: number }).port;

    const transport = new UdpTransport({
      remoteAddress: '127.0.0.1',
      remotePort: serverPort,
      localAddress: '127.0.0.1',
    });
    await transport.bind();

    const ack = new TunnellingAck({ communicationChannelId: 7, sequenceCounter: 3 });
    const frame = KNXIPFrame.fromBody(ack);
    const expected = frame.toKnx();

    const recv = once<[Buffer]>(server, 'message');
    await transport.send(frame);
    const [received] = await recv;
    assert.deepEqual(Array.from(received), Array.from(expected));

    await transport.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('emits "raw" on a non-KNX-IP packet', async () => {
    const transport = new UdpTransport({
      remoteAddress: '127.0.0.1',
      remotePort: 0,
      localAddress: '127.0.0.1',
    });
    const bound = await transport.bind();

    const sender = dgram.createSocket('udp4');
    await new Promise<void>((resolve) => sender.bind(0, '127.0.0.1', resolve));

    const rawWait = once<[Buffer, unknown, Error]>(transport, 'raw');
    sender.send(Buffer.from([0xff, 0xff, 0xff]), bound.port, '127.0.0.1');
    const [, , err] = await rawWait;
    assert.ok(err instanceof Error);

    await transport.close();
    await new Promise<void>((resolve) => sender.close(() => resolve()));
  });

  it('rejects send after close', async () => {
    const transport = new UdpTransport({
      remoteAddress: '127.0.0.1',
      remotePort: 1,
    });
    await transport.bind();
    await transport.close();
    const ack = KNXIPFrame.fromBody(
      new TunnellingAck({ communicationChannelId: 0, sequenceCounter: 0 }),
    );
    await assert.rejects(() => transport.send(ack), /closed/);
  });
});

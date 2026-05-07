import { strict as assert } from 'node:assert';
import * as net from 'node:net';
import { describe, it } from 'node:test';
import { ConnectionStateRequest } from '../../src/core/bodies';
import { KNXIPFrame } from '../../src/core/knxipFrame';
import { TcpTransport } from '../../src/io/tcpTransport';

/** Spin up a TCP server on 127.0.0.1:0 that captures everything it receives. */
function startEchoServer(): Promise<{ port: number; server: net.Server; received: Buffer[] }> {
  return new Promise((resolve, reject) => {
    const received: Buffer[] = [];
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        received.push(chunk);
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr !== 'object' || addr === null) {
        reject(new Error('Bad listening address'));
        return;
      }
      resolve({ port: (addr as net.AddressInfo).port, server, received });
    });
  });
}

describe('TcpTransport', () => {
  it('connects and sends a frame as bytes the server can receive', async () => {
    const { port, server, received } = await startEchoServer();
    const transport = new TcpTransport({ remoteAddress: '127.0.0.1', remotePort: port });
    await transport.bind();
    const frame = KNXIPFrame.fromBody(new ConnectionStateRequest({ communicationChannelId: 7 }));
    await transport.send(frame);

    // Give the server a microtick to receive.
    await new Promise((r) => setTimeout(r, 50));
    const total = Buffer.concat(received);
    assert.deepEqual(total, frame.toKnx());

    await transport.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('reassembles fragmented frames into one "message"', async () => {
    const { port, server, received } = await startEchoServer();
    // Pair: server pushes bytes back to the client a few bytes at a time.
    server.on('connection', (socket) => {
      const frame1 = KNXIPFrame.fromBody(new ConnectionStateRequest({ communicationChannelId: 1 }));
      const frame2 = KNXIPFrame.fromBody(new ConnectionStateRequest({ communicationChannelId: 2 }));
      const both = Buffer.concat([frame1.toKnx(), frame2.toKnx()]);
      // Push the combined buffer in 3 awkward fragments.
      socket.write(both.subarray(0, 3));
      setTimeout(() => socket.write(both.subarray(3, 13)), 10);
      setTimeout(() => socket.write(both.subarray(13)), 20);
    });

    const transport = new TcpTransport({ remoteAddress: '127.0.0.1', remotePort: port });
    const messages: number[] = [];
    transport.on('message', (frame: KNXIPFrame) => {
      const body = frame.body as ConnectionStateRequest;
      messages.push(body.communicationChannelId);
    });
    await transport.bind();

    // Wait for both frames.
    await new Promise<void>((r) => {
      const start = Date.now();
      const tick = () => {
        if (messages.length >= 2 || Date.now() - start > 500) r();
        else setTimeout(tick, 10);
      };
      tick();
    });
    assert.deepEqual(messages.sort(), [1, 2]);

    await transport.close();
    await new Promise<void>((r) => server.close(() => r()));
    void received; // silence unused
  });
});

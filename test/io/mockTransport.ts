import { EventEmitter } from 'node:events';
import {
  ConnectResponse,
  ConnectionStateResponse,
  DisconnectResponse,
  TunnellingAck,
  TunnellingRequest,
} from '../../src/core/bodies';
import { CRD } from '../../src/core/cri';
import { HPAI } from '../../src/core/hpai';
import { KNXIPFrame } from '../../src/core/knxipFrame';
import { ErrorCode } from '../../src/core/serviceTypes';
import type { SocketAddress } from '../../src/io/udpTransport';

/**
 * In-memory stand-in for UdpTransport that satisfies the same event surface.
 * Tests can `inject(frame)` to simulate gateway responses and inspect `sent` to
 * assert what the tunnel transmitted.
 */
export class MockTransport extends EventEmitter {
  readonly sent: { frame: KNXIPFrame; addr?: SocketAddress }[] = [];
  bound: SocketAddress = { address: '127.0.0.1', port: 50000 };
  closed = false;

  // UdpTransport API -------------------------------------------------------
  bind(): Promise<SocketAddress> {
    return Promise.resolve(this.bound);
  }

  send(frame: KNXIPFrame, addr?: SocketAddress): Promise<void> {
    this.sent.push(addr === undefined ? { frame } : { frame, addr });
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    queueMicrotask(() => this.emit('close'));
    return Promise.resolve();
  }

  // Test helpers -----------------------------------------------------------
  inject(frame: KNXIPFrame, source: SocketAddress = { address: '1.2.3.4', port: 3671 }): void {
    this.emit('message', frame, source);
  }

  /** Auto-ack the most recent TunnellingRequest. */
  ackLast(status: ErrorCode = ErrorCode.E_NO_ERROR): void {
    const lastReq = [...this.sent].reverse().find((s) => s.frame.body instanceof TunnellingRequest);
    if (!lastReq) throw new Error('No TunnellingRequest to ack');
    const tr = lastReq.frame.body as TunnellingRequest;
    this.inject(
      KNXIPFrame.fromBody(
        new TunnellingAck({
          communicationChannelId: tr.communicationChannelId,
          sequenceCounter: tr.sequenceCounter,
          statusCode: status,
        }),
      ),
    );
  }

  injectConnectResponse(opts: {
    channelId?: number;
    assignedAddress?: string;
    statusCode?: ErrorCode;
    dataEndpoint?: HPAI;
  } = {}): void {
    this.inject(
      KNXIPFrame.fromBody(
        new ConnectResponse({
          communicationChannelId: opts.channelId ?? 1,
          statusCode: opts.statusCode ?? ErrorCode.E_NO_ERROR,
          dataEndpoint: opts.dataEndpoint ?? HPAI.routeBack(),
          crd: new CRD({ individualAddress: opts.assignedAddress ?? '15.15.250' }),
        }),
      ),
    );
  }

  injectConnectionStateResponse(channelId = 1, status: ErrorCode = ErrorCode.E_NO_ERROR): void {
    this.inject(
      KNXIPFrame.fromBody(
        new ConnectionStateResponse({ communicationChannelId: channelId, statusCode: status }),
      ),
    );
  }

  injectDisconnectResponse(channelId = 1): void {
    this.inject(
      KNXIPFrame.fromBody(new DisconnectResponse({ communicationChannelId: channelId })),
    );
  }
}

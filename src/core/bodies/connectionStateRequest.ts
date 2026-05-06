// CONNECTIONSTATE_REQUEST — heartbeat to verify the tunnel is alive.
//   [0] communication channel id
//   [1] reserved (0x00)
//   [2..9] HPAI control endpoint

import { CouldNotParseKNXIP } from '../errors';
import { HPAI } from '../hpai';
import { ServiceType } from '../serviceTypes';

export interface ConnectionStateRequestInit {
  communicationChannelId?: number;
  controlEndpoint?: HPAI;
}

export class ConnectionStateRequest {
  static readonly SERVICE_TYPE = ServiceType.CONNECTIONSTATE_REQUEST;

  communicationChannelId: number;
  controlEndpoint: HPAI;

  constructor(init: ConnectionStateRequestInit = {}) {
    this.communicationChannelId = init.communicationChannelId ?? 0;
    this.controlEndpoint = init.controlEndpoint ?? HPAI.routeBack();
  }

  calculatedLength(): number {
    return 2 + HPAI.LENGTH;
  }

  static fromKnx(
    raw: Buffer,
    offset = 0,
  ): { body: ConnectionStateRequest; bytesRead: number } {
    if (raw.length - offset < 2 + HPAI.LENGTH) {
      throw new CouldNotParseKNXIP('CONNECTIONSTATE_REQUEST too short');
    }
    const { hpai, bytesRead } = HPAI.fromKnx(raw, offset + 2);
    return {
      body: new ConnectionStateRequest({
        communicationChannelId: raw[offset]!,
        controlEndpoint: hpai,
      }),
      bytesRead: 2 + bytesRead,
    };
  }

  toKnx(): Buffer {
    return Buffer.concat([
      Buffer.from([this.communicationChannelId, 0x00]),
      this.controlEndpoint.toKnx(),
    ]);
  }
}

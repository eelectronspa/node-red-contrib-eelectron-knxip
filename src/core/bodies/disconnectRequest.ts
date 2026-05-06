// DISCONNECT_REQUEST — same shape as CONNECTIONSTATE_REQUEST.

import { CouldNotParseKNXIP } from '../errors';
import { HPAI } from '../hpai';
import { ServiceType } from '../serviceTypes';

export interface DisconnectRequestInit {
  communicationChannelId?: number;
  controlEndpoint?: HPAI;
}

export class DisconnectRequest {
  static readonly SERVICE_TYPE = ServiceType.DISCONNECT_REQUEST;

  communicationChannelId: number;
  controlEndpoint: HPAI;

  constructor(init: DisconnectRequestInit = {}) {
    this.communicationChannelId = init.communicationChannelId ?? 0;
    this.controlEndpoint = init.controlEndpoint ?? HPAI.routeBack();
  }

  calculatedLength(): number {
    return 2 + HPAI.LENGTH;
  }

  static fromKnx(raw: Buffer, offset = 0): { body: DisconnectRequest; bytesRead: number } {
    if (raw.length - offset < 2 + HPAI.LENGTH) {
      throw new CouldNotParseKNXIP('DISCONNECT_REQUEST too short');
    }
    const { hpai, bytesRead } = HPAI.fromKnx(raw, offset + 2);
    return {
      body: new DisconnectRequest({
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

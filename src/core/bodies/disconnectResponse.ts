// DISCONNECT_RESPONSE — same shape as CONNECTIONSTATE_RESPONSE.

import { CouldNotParseKNXIP } from '../errors';
import { ErrorCode, ServiceType } from '../serviceTypes';

export interface DisconnectResponseInit {
  communicationChannelId?: number;
  statusCode?: ErrorCode;
}

export class DisconnectResponse {
  static readonly SERVICE_TYPE = ServiceType.DISCONNECT_RESPONSE;

  communicationChannelId: number;
  statusCode: ErrorCode;

  constructor(init: DisconnectResponseInit = {}) {
    this.communicationChannelId = init.communicationChannelId ?? 0;
    this.statusCode = init.statusCode ?? ErrorCode.E_NO_ERROR;
  }

  calculatedLength(): number {
    return 2;
  }

  static fromKnx(raw: Buffer, offset = 0): { body: DisconnectResponse; bytesRead: number } {
    if (raw.length - offset < 2) {
      throw new CouldNotParseKNXIP('DISCONNECT_RESPONSE too short');
    }
    return {
      body: new DisconnectResponse({
        communicationChannelId: raw[offset]!,
        statusCode: raw[offset + 1]! as ErrorCode,
      }),
      bytesRead: 2,
    };
  }

  toKnx(): Buffer {
    return Buffer.from([this.communicationChannelId, this.statusCode]);
  }
}

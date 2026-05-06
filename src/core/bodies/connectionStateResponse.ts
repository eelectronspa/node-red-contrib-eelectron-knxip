// CONNECTIONSTATE_RESPONSE — 2 bytes: channel + status.

import { CouldNotParseKNXIP } from '../errors';
import { ErrorCode, ServiceType } from '../serviceTypes';

export interface ConnectionStateResponseInit {
  communicationChannelId?: number;
  statusCode?: ErrorCode;
}

export class ConnectionStateResponse {
  static readonly SERVICE_TYPE = ServiceType.CONNECTIONSTATE_RESPONSE;

  communicationChannelId: number;
  statusCode: ErrorCode;

  constructor(init: ConnectionStateResponseInit = {}) {
    this.communicationChannelId = init.communicationChannelId ?? 0;
    this.statusCode = init.statusCode ?? ErrorCode.E_NO_ERROR;
  }

  calculatedLength(): number {
    return 2;
  }

  static fromKnx(
    raw: Buffer,
    offset = 0,
  ): { body: ConnectionStateResponse; bytesRead: number } {
    if (raw.length - offset < 2) {
      throw new CouldNotParseKNXIP('CONNECTIONSTATE_RESPONSE too short');
    }
    return {
      body: new ConnectionStateResponse({
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

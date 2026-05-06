// TUNNELLING_ACK — fixed 4 bytes:
//   [0] structure length (0x04)
//   [1] communication channel id
//   [2] sequence counter (must echo the request)
//   [3] status

import { CouldNotParseKNXIP } from '../errors';
import { ErrorCode, ServiceType } from '../serviceTypes';

export interface TunnellingAckInit {
  communicationChannelId: number;
  sequenceCounter: number;
  statusCode?: ErrorCode;
}

export class TunnellingAck {
  static readonly SERVICE_TYPE = ServiceType.TUNNELLING_ACK;
  static readonly STRUCT_LENGTH = 0x04;

  communicationChannelId: number;
  sequenceCounter: number;
  statusCode: ErrorCode;

  constructor(init: TunnellingAckInit) {
    this.communicationChannelId = init.communicationChannelId;
    this.sequenceCounter = init.sequenceCounter & 0xff;
    this.statusCode = init.statusCode ?? ErrorCode.E_NO_ERROR;
  }

  calculatedLength(): number {
    return TunnellingAck.STRUCT_LENGTH;
  }

  static fromKnx(raw: Buffer, offset = 0): { body: TunnellingAck; bytesRead: number } {
    if (raw.length - offset < TunnellingAck.STRUCT_LENGTH) {
      throw new CouldNotParseKNXIP('TUNNELLING_ACK too short');
    }
    const structLen = raw[offset]!;
    if (structLen !== TunnellingAck.STRUCT_LENGTH) {
      throw new CouldNotParseKNXIP(`Unexpected TUNNELLING_ACK struct length ${structLen}`);
    }
    return {
      body: new TunnellingAck({
        communicationChannelId: raw[offset + 1]!,
        sequenceCounter: raw[offset + 2]!,
        statusCode: raw[offset + 3]! as ErrorCode,
      }),
      bytesRead: TunnellingAck.STRUCT_LENGTH,
    };
  }

  toKnx(): Buffer {
    return Buffer.from([
      TunnellingAck.STRUCT_LENGTH,
      this.communicationChannelId,
      this.sequenceCounter & 0xff,
      this.statusCode,
    ]);
  }
}

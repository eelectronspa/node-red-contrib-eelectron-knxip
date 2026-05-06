// TUNNELLING_REQUEST — wraps a raw CEMI frame with channel + sequence metadata.
//   [0] structure length (0x04, fixed)
//   [1] communication channel id
//   [2] sequence counter (uint8, wraps 0..255)
//   [3] reserved (0x00)
//   [4..] raw CEMI frame
//
// We deliberately keep `rawCemi` as bytes here — the tunnel parses the CEMI
// lazily after sending the ACK, so a malformed CEMI never breaks the ACK path.

import { CouldNotParseKNXIP } from '../errors';
import { ServiceType } from '../serviceTypes';

export interface TunnellingRequestInit {
  communicationChannelId: number;
  sequenceCounter: number;
  rawCemi: Buffer;
}

export class TunnellingRequest {
  static readonly SERVICE_TYPE = ServiceType.TUNNELLING_REQUEST;
  static readonly STRUCT_LENGTH = 0x04;

  communicationChannelId: number;
  sequenceCounter: number;
  rawCemi: Buffer;

  constructor(init: TunnellingRequestInit) {
    this.communicationChannelId = init.communicationChannelId;
    this.sequenceCounter = init.sequenceCounter & 0xff;
    this.rawCemi = init.rawCemi;
  }

  calculatedLength(): number {
    return TunnellingRequest.STRUCT_LENGTH + this.rawCemi.length;
  }

  static fromKnx(raw: Buffer, offset = 0): { body: TunnellingRequest; bytesRead: number } {
    const available = raw.length - offset;
    if (available < TunnellingRequest.STRUCT_LENGTH) {
      throw new CouldNotParseKNXIP('TUNNELLING_REQUEST too short');
    }
    const structLen = raw[offset]!;
    if (structLen !== TunnellingRequest.STRUCT_LENGTH) {
      throw new CouldNotParseKNXIP(
        `Unexpected TUNNELLING_REQUEST struct length ${structLen}`,
      );
    }
    const channelId = raw[offset + 1]!;
    const seq = raw[offset + 2]!;
    // raw[offset + 3] is reserved (0x00); ignore the value.
    const rawCemi = Buffer.from(raw.subarray(offset + structLen));
    return {
      body: new TunnellingRequest({
        communicationChannelId: channelId,
        sequenceCounter: seq,
        rawCemi,
      }),
      bytesRead: structLen + rawCemi.length,
    };
  }

  toKnx(): Buffer {
    const out = Buffer.alloc(TunnellingRequest.STRUCT_LENGTH + this.rawCemi.length);
    out[0] = TunnellingRequest.STRUCT_LENGTH;
    out[1] = this.communicationChannelId;
    out[2] = this.sequenceCounter & 0xff;
    out[3] = 0x00; // reserved
    this.rawCemi.copy(out, TunnellingRequest.STRUCT_LENGTH);
    return out;
  }
}

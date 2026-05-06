// KNX/IP frame header — fixed 6 bytes:
//   [0] header length (always 0x06)
//   [1] protocol version (always 0x10)
//   [2..3] service type identifier (uint16 BE)
//   [4..5] total length including header (uint16 BE)

import { CouldNotParseKNXIP, IncompleteKNXIPFrame } from './errors';
import { HEADER_SIZE_10, KNXNETIP_VERSION_10, type ServiceType } from './serviceTypes';

export class KNXIPHeader {
  static readonly LENGTH = HEADER_SIZE_10;

  serviceType: ServiceType | number;
  totalLength: number;

  constructor(serviceType: ServiceType | number, totalLength = 0) {
    this.serviceType = serviceType;
    this.totalLength = totalLength;
  }

  /**
   * Parse a header from `data`. Returns the consumed byte count (always 6 on success).
   * Throws {@link IncompleteKNXIPFrame} when the buffer is shorter than the header,
   * and {@link CouldNotParseKNXIP} when the header bytes are malformed.
   */
  static fromKnx(data: Buffer): { header: KNXIPHeader; bytesRead: number } {
    if (data.length < KNXIPHeader.LENGTH) {
      throw new IncompleteKNXIPFrame('buffer shorter than header length');
    }
    if (data[0] !== KNXIPHeader.LENGTH) {
      throw new CouldNotParseKNXIP(`unexpected header length 0x${data[0]!.toString(16)}`);
    }
    if (data[1] !== KNXNETIP_VERSION_10) {
      throw new CouldNotParseKNXIP(`unsupported protocol version 0x${data[1]!.toString(16)}`);
    }
    const serviceType = data.readUInt16BE(2);
    const totalLength = data.readUInt16BE(4);
    return {
      header: new KNXIPHeader(serviceType, totalLength),
      bytesRead: KNXIPHeader.LENGTH,
    };
  }

  /** Serialize to a 6-byte buffer. */
  toKnx(): Buffer {
    const buf = Buffer.alloc(KNXIPHeader.LENGTH);
    buf[0] = KNXIPHeader.LENGTH;
    buf[1] = KNXNETIP_VERSION_10;
    buf.writeUInt16BE(this.serviceType, 2);
    buf.writeUInt16BE(this.totalLength, 4);
    return buf;
  }
}

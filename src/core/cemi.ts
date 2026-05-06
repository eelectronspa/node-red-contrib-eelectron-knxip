// Common External Message Interface (CEMI). The cEMI frame is the inner
// message KNX/IP carries between the IP transport and the KNX bus.
//
// CEMIFrame on the wire:
//   [0]    message code (L_DATA_REQ=0x11, L_DATA_IND=0x29, L_DATA_CON=0x2E)
//   [1]    additional info length (n)
//   [2..2+n)  additional info bytes (almost always empty)
//   [2+n..]   service info (CEMILData below for L_DATA_*)
//
// CEMILData service info:
//   [0..2]   control fields (16-bit flags, see CEMIFlags)
//   [2..4]   source individual address
//   [4..6]   destination address (group or individual)
//   [6]      NPDU length
//   [7..]    TPDU (TPCI byte + APDU bytes)
//
// NPDU length excludes the TPCI/APCI byte. APDU length = NPDU length + 1.

import { GroupAddress, IndividualAddress } from './address';
import { type APCI, apciNpduLength, decodeApci, encodeApci } from './apci';
import { CouldNotParseCEMI, ConversionError } from './errors';
import { encodeTpci, isControlTpci, resolveTpci, type TPCI } from './tpci';

export const CEMIMessageCode = {
  L_DATA_REQ: 0x11,
  L_DATA_IND: 0x29,
  L_DATA_CON: 0x2e,
} as const;
export type CEMIMessageCode = (typeof CEMIMessageCode)[keyof typeof CEMIMessageCode];

const CEMI_MESSAGE_CODE_NAMES: Record<number, string> = {
  [CEMIMessageCode.L_DATA_REQ]: 'L_DATA_REQ',
  [CEMIMessageCode.L_DATA_IND]: 'L_DATA_IND',
  [CEMIMessageCode.L_DATA_CON]: 'L_DATA_CON',
};

export function cemiMessageCodeName(code: number): string {
  return CEMI_MESSAGE_CODE_NAMES[code] ?? `UNKNOWN_0x${code.toString(16)}`;
}

/** 16-bit control field constants (control 1 in high byte, control 2 in low byte). */
export const CEMIFlags = {
  // control 1
  FRAME_TYPE_EXTENDED: 0x0000,
  FRAME_TYPE_STANDARD: 0x8000,
  REPEAT: 0x0000,
  DO_NOT_REPEAT: 0x2000,
  SYSTEM_BROADCAST: 0x0000,
  BROADCAST: 0x1000,
  PRIORITY_SYSTEM: 0x0000,
  PRIORITY_NORMAL: 0x0400,
  PRIORITY_URGENT: 0x0800,
  PRIORITY_LOW: 0x0c00,
  NO_ACK_REQUESTED: 0x0000,
  ACK_REQUESTED: 0x0200,
  CONFIRM_NO_ERROR: 0x0000,
  CONFIRM_ERROR: 0x0100,
  // control 2
  DESTINATION_INDIVIDUAL_ADDRESS: 0x0000,
  DESTINATION_GROUP_ADDRESS: 0x0080,
  HOP_COUNT_NO: 0x0070,
  HOP_COUNT_1ST: 0x0060,
  STANDARD_FRAME_FORMAT: 0x0000,
  EXTENDED_FRAME_FORMAT: 0x0001,
} as const;

/** Default control flags for an outgoing tunnel L_DATA_REQ. */
export const DEFAULT_OUTGOING_FLAGS =
  CEMIFlags.FRAME_TYPE_STANDARD |
  CEMIFlags.DO_NOT_REPEAT |
  CEMIFlags.BROADCAST |
  CEMIFlags.NO_ACK_REQUESTED |
  CEMIFlags.CONFIRM_NO_ERROR |
  CEMIFlags.HOP_COUNT_1ST;

export interface CEMILDataInit {
  flags: number;
  srcAddr: IndividualAddress;
  dstAddr: GroupAddress | IndividualAddress;
  tpci: TPCI;
  payload: APCI | null;
}

export class CEMILData {
  flags: number;
  srcAddr: IndividualAddress;
  dstAddr: GroupAddress | IndividualAddress;
  tpci: TPCI;
  payload: APCI | null;

  constructor(init: CEMILDataInit) {
    this.flags = init.flags;
    this.srcAddr = init.srcAddr;
    this.dstAddr = init.dstAddr;
    this.tpci = init.tpci;
    this.payload = init.payload;
  }

  /** Hop count (3 bits). */
  get hops(): number {
    return (this.flags & 0x0070) >> 4;
  }

  set hops(val: number) {
    this.flags = (this.flags & ~0x0070) | ((val & 0x07) << 4);
  }

  calculatedLength(): number {
    if (isControlTpci(this.tpci)) {
      if (this.payload !== null) {
        throw new ConversionError('Control TPDU must not carry an APCI payload');
      }
      // 2 (flags) + 2 (src) + 2 (dst) + 1 (npdu len) + 1 (tpci byte) = 8
      return 8;
    }
    if (this.payload === null) {
      throw new ConversionError('Data TPDU must carry an APCI payload');
    }
    // 7 fixed + 1 (first APDU byte = TPCI|apci-high) + npdu-length-payload-bytes
    return 8 + apciNpduLength(this.payload);
  }

  toKnx(): Buffer {
    const out = Buffer.alloc(this.calculatedLength());
    out.writeUInt16BE(this.flags, 0);
    this.srcAddr.toKnx().copy(out, 2);
    this.dstAddr.toKnx().copy(out, 4);

    if (isControlTpci(this.tpci)) {
      out[6] = 0; // NPDU length
      out[7] = encodeTpci(this.tpci);
      return out;
    }

    // Data TPDU: NPDU length excludes the TPCI/APCI byte
    const apci = this.payload!;
    const apdu = encodeApci(apci);
    apdu[0] = (apdu[0] ?? 0) | encodeTpci(this.tpci); // OR TPCI bits into the APCI byte
    out[6] = apciNpduLength(apci);
    apdu.copy(out, 7);
    return out;
  }

  static fromKnx(raw: Buffer, offset = 0): { data: CEMILData; bytesRead: number } {
    const available = raw.length - offset;
    if (available < 8) {
      throw new CouldNotParseCEMI(`L_Data CEMI too small (${available} bytes)`);
    }

    const flags = raw.readUInt16BE(offset + 0);
    const srcAddr = IndividualAddress.fromKnx(raw, offset + 2);

    const dstIsGroup = (flags & CEMIFlags.DESTINATION_GROUP_ADDRESS) !== 0;
    const dstAddr: GroupAddress | IndividualAddress = dstIsGroup
      ? GroupAddress.fromKnx(raw, offset + 4)
      : IndividualAddress.fromKnx(raw, offset + 4);

    const npduLen = raw[offset + 6]!;
    const tpduStart = offset + 7;
    const tpduLen = available - 7;

    if (tpduLen < 1) {
      throw new CouldNotParseCEMI('CEMI L_Data missing TPDU');
    }

    const tpciByte = raw[tpduStart]!;
    const tpci = resolveTpci(tpciByte, dstIsGroup, dstAddr.raw === 0);

    if (isControlTpci(tpci)) {
      if (npduLen !== 0) {
        throw new CouldNotParseCEMI(`Control TPDU must have NPDU length 0, got ${npduLen}`);
      }
      const data = new CEMILData({ flags, srcAddr, dstAddr, tpci, payload: null });
      return { data, bytesRead: 8 };
    }

    // Data TPDU: APDU length = NPDU length + 1; first APDU byte has TPCI bits cleared
    const apduLen = npduLen + 1;
    if (tpduLen < apduLen) {
      throw new CouldNotParseCEMI(
        `APDU truncated: expected ${apduLen} bytes, got ${tpduLen}`,
      );
    }
    const apdu = Buffer.alloc(apduLen);
    apdu[0] = tpciByte & 0b11;
    raw.copy(apdu, 1, tpduStart + 1, tpduStart + apduLen);

    const payload = decodeApci(apdu);
    const data = new CEMILData({ flags, srcAddr, dstAddr, tpci, payload });
    return { data, bytesRead: 7 + apduLen };
  }
}

export interface CEMIFrameInit {
  code: CEMIMessageCode;
  additionalInfo?: Buffer;
  data: CEMILData;
}

export class CEMIFrame {
  code: CEMIMessageCode;
  additionalInfo: Buffer;
  data: CEMILData;

  constructor(init: CEMIFrameInit) {
    this.code = init.code;
    this.additionalInfo = init.additionalInfo ?? Buffer.alloc(0);
    this.data = init.data;
  }

  calculatedLength(): number {
    // 1 (code) + 1 (info length) + info bytes + data
    return 2 + this.additionalInfo.length + this.data.calculatedLength();
  }

  toKnx(): Buffer {
    const dataBuf = this.data.toKnx();
    const out = Buffer.alloc(2 + this.additionalInfo.length + dataBuf.length);
    out[0] = this.code;
    out[1] = this.additionalInfo.length;
    this.additionalInfo.copy(out, 2);
    dataBuf.copy(out, 2 + this.additionalInfo.length);
    return out;
  }

  static fromKnx(raw: Buffer, offset = 0): { frame: CEMIFrame; bytesRead: number } {
    const available = raw.length - offset;
    if (available < 2) throw new CouldNotParseCEMI('CEMI shorter than 2 bytes');

    const code = raw[offset]!;
    if (
      code !== CEMIMessageCode.L_DATA_REQ &&
      code !== CEMIMessageCode.L_DATA_IND &&
      code !== CEMIMessageCode.L_DATA_CON
    ) {
      throw new CouldNotParseCEMI(`Unsupported CEMI message code 0x${code.toString(16)}`);
    }

    const infoLen = raw[offset + 1]!;
    if (available < 2 + infoLen) {
      throw new CouldNotParseCEMI('CEMI additional-info length exceeds buffer');
    }
    const additionalInfo = Buffer.from(raw.subarray(offset + 2, offset + 2 + infoLen));

    const { data, bytesRead } = CEMILData.fromKnx(raw, offset + 2 + infoLen);

    const frame = new CEMIFrame({ code: code as CEMIMessageCode, additionalInfo, data });
    return { frame, bytesRead: 2 + infoLen + bytesRead };
  }
}

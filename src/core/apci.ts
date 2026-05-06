// Application Layer Protocol Control Information.
//
// APCI services are 10-bit codes split across two bytes of the APDU:
//   APDU byte 0 (low 2 bits): top 2 bits of the 10-bit APCI service
//   APDU byte 1 (all 8 bits): bottom 8 bits of the service, OR'd with the small payload
//
// For payloads <= 6 bits ("small"), the value is packed into the low 6 bits of byte 1.
// For larger payloads ("bytes"), raw bytes follow byte 1.
//
// Only the three group services are supported in this milestone — sufficient for
// tunneling. Memory/Property/IndividualAddress services are out of scope.

import { ConversionError } from './errors';

/** 10-bit APCI service codes (only the group subset for now). */
export const APCIService = {
  GROUP_READ: 0x0000,
  GROUP_RESPONSE: 0x0040,
  GROUP_WRITE: 0x0080,
} as const;

/** Mask isolating the 10-bit APCI service (across two APDU bytes). */
const APCI_SERVICE_MASK_10 = 0x03ff;
/** Mask for the high-level group/family classifier (top 4 bits of the 10-bit code). */
const APCI_SERVICE_GROUP_MASK = 0x03c0;
/** Low 6 bits of byte 1 carry the small payload. */
const APCI_SMALL_PAYLOAD_MASK = 0x3f;

/**
 * APDU value carried by GroupValueWrite / GroupValueResponse.
 *
 * `small` packs into the low 6 bits of the APCI byte (1-bit, 2-bit, ..., 6-bit DPTs).
 * `bytes` appends raw bytes after the APCI header (everything from DPT5 upwards).
 *
 * The distinction is significant on the wire — for a 1-bit DPT, the same value sent
 * as `small` produces a 2-byte APDU and as `bytes` produces a 3-byte APDU. Both are
 * legal but devices interpret them differently, so we make the caller choose.
 */
export type APDUValue =
  | { kind: 'small'; value: number }
  | { kind: 'bytes'; value: Buffer };

export type APCI =
  | { kind: 'GroupValueRead' }
  | { kind: 'GroupValueWrite'; data: APDUValue }
  | { kind: 'GroupValueResponse'; data: APDUValue }
  /**
   * Any service we don't model — keeps the full 10-bit code and raw APDU bytes
   * so callers can introspect or pass through. Common cases on the bus:
   * 0x300/0x340 (DeviceDescriptorRead/Response — point-to-point management),
   * 0x200/0x240/0x280 (Memory*), 0x100/0x140 (IndividualAddress*).
   */
  | { kind: 'Unknown'; service: number; raw: Buffer };

export const groupValueRead = (): APCI => ({ kind: 'GroupValueRead' });
export const groupValueWrite = (data: APDUValue): APCI => ({ kind: 'GroupValueWrite', data });
export const groupValueResponse = (data: APDUValue): APCI => ({
  kind: 'GroupValueResponse',
  data,
});

/** Convenience: wrap a number into a small APDU value, validating the 6-bit range. */
export function smallValue(value: number): APDUValue {
  if (!Number.isInteger(value) || value < 0 || value > APCI_SMALL_PAYLOAD_MASK) {
    throw new ConversionError(`small APDU value out of range (0..63): ${value}`);
  }
  return { kind: 'small', value };
}

/** Convenience: wrap a buffer into a bytes APDU value. */
export function bytesValue(value: Buffer): APDUValue {
  return { kind: 'bytes', value };
}

/**
 * NPDU length carried in CEMI (bytes after the npdu-length octet, minus the
 * leading TPCI/APCI byte). Equivalently, APDU length minus 1.
 */
export function apciNpduLength(apci: APCI): number {
  switch (apci.kind) {
    case 'GroupValueRead':
      return 1;
    case 'GroupValueWrite':
    case 'GroupValueResponse':
      return apci.data.kind === 'small' ? 1 : 1 + apci.data.value.length;
    case 'Unknown':
      // raw includes the full APDU; NPDU length excludes the first byte.
      return Math.max(1, apci.raw.length - 1);
  }
}

/**
 * Encode an APCI to its APDU bytes. The returned buffer has TPCI bits zeroed in
 * byte 0 — the CEMI encoder OR-s `encodeTpci(tpci)` in afterwards.
 *
 * The buffer is fresh and mutable; the caller is allowed to modify it (this is
 * relied on for the TPCI-OR-in trick).
 */
export function encodeApci(apci: APCI): Buffer {
  switch (apci.kind) {
    case 'GroupValueRead':
      return encodeCmdAndPayload(APCIService.GROUP_READ, null);
    case 'GroupValueWrite':
      return encodeCmdAndPayload(APCIService.GROUP_WRITE, apci.data);
    case 'GroupValueResponse':
      return encodeCmdAndPayload(APCIService.GROUP_RESPONSE, apci.data);
    case 'Unknown':
      return Buffer.from(apci.raw);
  }
}

function encodeCmdAndPayload(service: number, data: APDUValue | null): Buffer {
  const byte0 = (service >> 8) & 0b11;
  let byte1 = service & 0xff;
  let appended: Buffer | null = null;
  if (data?.kind === 'small') {
    byte1 |= data.value & APCI_SMALL_PAYLOAD_MASK;
  } else if (data?.kind === 'bytes') {
    appended = data.value;
  }
  if (appended) {
    const out = Buffer.alloc(2 + appended.length);
    out[0] = byte0;
    out[1] = byte1;
    appended.copy(out, 2);
    return out;
  }
  const out = Buffer.alloc(2);
  out[0] = byte0;
  out[1] = byte1;
  return out;
}

/**
 * Decode an APDU into an APCI. The TPCI bits in byte 0 are masked out internally —
 * the caller may pass the raw APDU as received, no pre-cleaning required.
 */
export function decodeApci(apdu: Buffer): APCI {
  if (apdu.length < 2) {
    throw new ConversionError(`APDU too short: ${apdu.length} bytes`);
  }
  const apciCode = ((apdu[0]! << 8) | apdu[1]!) & APCI_SERVICE_MASK_10;
  const service = apciCode & APCI_SERVICE_GROUP_MASK;

  switch (service) {
    case APCIService.GROUP_READ:
      return groupValueRead();
    case APCIService.GROUP_WRITE:
      return groupValueWrite(extractData(apdu));
    case APCIService.GROUP_RESPONSE:
      return groupValueResponse(extractData(apdu));
    default:
      // Out-of-scope service (device descriptor, memory, property, etc.).
      // Surface as a tagged Unknown so the CEMI parser doesn't fail and the
      // listener can filter it out by `apci.kind` like any other variant.
      return { kind: 'Unknown', service: apciCode, raw: Buffer.from(apdu) };
  }
}

function extractData(apdu: Buffer): APDUValue {
  if (apdu.length === 2) {
    return { kind: 'small', value: apdu[1]! & APCI_SMALL_PAYLOAD_MASK };
  }
  return { kind: 'bytes', value: Buffer.from(apdu.subarray(2)) };
}

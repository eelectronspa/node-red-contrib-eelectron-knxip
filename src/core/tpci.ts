// Transport Layer Protocol Control Information.
//
// TPCI shares its byte with the upper bits of the APCI for data telegrams. The byte
// is laid out as:
//   bit 7   control bit (1 = control TPDU, 0 = data TPDU)
//   bit 6   numbered bit (1 = sequence number present)
//   bits 5-2  sequence number (4-bit)
//   bits 1-0  for control TPDUs: control flags (00=Connect, 01=Disconnect, 10=Ack, 11=Nak)
//             for data TPDUs: high 2 bits of APCI (consumer must mask in/out)
//
// See KNX Specifications 03_03_04 Transport Layer §2 TPDU.

import { ConversionError } from './errors';

const CONTROL_BIT = 0x80;
const NUMBERED_BIT = 0x40;

export type TPCI =
  | { kind: 'TDataGroup' }
  | { kind: 'TDataBroadcast' }
  | { kind: 'TDataTagGroup' }
  | { kind: 'TDataIndividual' }
  | { kind: 'TDataConnected'; sequenceNumber: number }
  | { kind: 'TConnect' }
  | { kind: 'TDisconnect' }
  | { kind: 'TAck'; sequenceNumber: number }
  | { kind: 'TNak'; sequenceNumber: number };

/**
 * True for control TPDUs (TConnect/TDisconnect/TAck/TNak). Control TPDUs carry
 * no APDU payload — the CEMI encoder uses this to decide whether to attach an APCI.
 */
export function isControlTpci(tpci: TPCI): boolean {
  switch (tpci.kind) {
    case 'TConnect':
    case 'TDisconnect':
    case 'TAck':
    case 'TNak':
      return true;
    default:
      return false;
  }
}

export const tDataGroup = (): TPCI => ({ kind: 'TDataGroup' });
export const tDataBroadcast = (): TPCI => ({ kind: 'TDataBroadcast' });
export const tDataTagGroup = (): TPCI => ({ kind: 'TDataTagGroup' });
export const tDataIndividual = (): TPCI => ({ kind: 'TDataIndividual' });
export const tDataConnected = (sequenceNumber: number): TPCI => ({
  kind: 'TDataConnected',
  sequenceNumber,
});
export const tConnect = (): TPCI => ({ kind: 'TConnect' });
export const tDisconnect = (): TPCI => ({ kind: 'TDisconnect' });
export const tAck = (sequenceNumber: number): TPCI => ({ kind: 'TAck', sequenceNumber });
export const tNak = (sequenceNumber: number): TPCI => ({ kind: 'TNak', sequenceNumber });

/**
 * Encode TPCI to its single-byte representation. For data TPDUs the bottom 2 bits
 * are reserved for the APCI high bits; the caller is expected to OR them in.
 */
export function encodeTpci(tpci: TPCI): number {
  switch (tpci.kind) {
    case 'TDataGroup':
    case 'TDataBroadcast':
    case 'TDataIndividual':
      return 0;
    case 'TDataTagGroup':
      // TDataTagGroup uses sequence_number=1 as a flag; APCI bits remain in bits 1-0.
      return (1 & 0x0f) << 2;
    case 'TDataConnected':
      return NUMBERED_BIT | ((tpci.sequenceNumber & 0x0f) << 2);
    case 'TConnect':
      return CONTROL_BIT | 0b00;
    case 'TDisconnect':
      return CONTROL_BIT | 0b01;
    case 'TAck':
      return CONTROL_BIT | NUMBERED_BIT | ((tpci.sequenceNumber & 0x0f) << 2) | 0b10;
    case 'TNak':
      return CONTROL_BIT | NUMBERED_BIT | ((tpci.sequenceNumber & 0x0f) << 2) | 0b11;
  }
}

/**
 * Resolve a raw TPCI byte (with APCI bits possibly still in bits 1-0) into the
 * appropriate TPCI variant. The caller supplies destination context because
 * group/broadcast/individual all share `control=0, numbered=0`.
 */
export function resolveTpci(
  rawTpci: number,
  dstIsGroupAddress: boolean,
  dstIsZero: boolean,
): TPCI {
  const control = (rawTpci & CONTROL_BIT) !== 0;
  const numbered = (rawTpci & NUMBERED_BIT) !== 0;
  const sequenceNumber = (rawTpci >> 2) & 0x0f;

  if (dstIsGroupAddress) {
    if (control || numbered) {
      throw new ConversionError('Invalid TPCI flags in group-addressed frame');
    }
    if (sequenceNumber === 0) {
      return dstIsZero ? tDataBroadcast() : tDataGroup();
    }
    if (sequenceNumber === 1) return tDataTagGroup();
  }

  if (!numbered && sequenceNumber !== 0) {
    throw new ConversionError('Sequence number not allowed for unnumbered TPCI');
  }

  if (!control) {
    // data TPDU — APCI bits in 1-0
    return numbered ? tDataConnected(sequenceNumber) : tDataIndividual();
  }

  // control TPDU
  const controlFlags = rawTpci & 0b11;
  if (!numbered) {
    if (controlFlags === 0b00) return tConnect();
    if (controlFlags === 0b01) return tDisconnect();
  } else {
    if (controlFlags === 0b10) return tAck(sequenceNumber);
    if (controlFlags === 0b11) return tNak(sequenceNumber);
  }

  throw new ConversionError(
    `Unknown TPCI 0b${rawTpci.toString(2).padStart(8, '0')}`,
  );
}

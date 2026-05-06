// User-facing Telegram type bridging CEMI and the higher-level node API.
//
// xknx auto-derives `tpci` from the destination address inside `__post_init__`.
// We do the same via constructor helpers — the Telegram type itself is a plain
// DTO so it serializes through `JSON.stringify` cleanly for logging/debugging.

import {
  GroupAddress,
  type GroupAddressInput,
  IndividualAddress,
  type IndividualAddressInput,
} from './address';
import {
  type APCI,
  type APDUValue,
  groupValueRead,
  groupValueResponse,
  groupValueWrite,
} from './apci';
import { type TPCI, tDataBroadcast, tDataGroup, tDataIndividual } from './tpci';

export type TelegramDirection = 'incoming' | 'outgoing';

export interface Telegram {
  destinationAddress: GroupAddress | IndividualAddress;
  sourceAddress: IndividualAddress;
  direction: TelegramDirection;
  payload: APCI | null;
  tpci: TPCI;
}

/** Default TPCI inferred from destination type, mirroring xknx. */
export function defaultTpci(dst: GroupAddress | IndividualAddress): TPCI {
  if (dst instanceof GroupAddress) return dst.raw === 0 ? tDataBroadcast() : tDataGroup();
  return tDataIndividual();
}

/** Source 0.0.0.0 = "let the gateway assign on send", per KNX/IP convention. */
const ANY_SOURCE = new IndividualAddress(0);

export function telegramFromGroupWrite(
  destination: GroupAddressInput,
  data: APDUValue,
  opts: { source?: IndividualAddressInput; direction?: TelegramDirection } = {},
): Telegram {
  const dst = new GroupAddress(destination);
  return {
    destinationAddress: dst,
    sourceAddress: opts.source ? new IndividualAddress(opts.source) : ANY_SOURCE,
    direction: opts.direction ?? 'outgoing',
    payload: groupValueWrite(data),
    tpci: defaultTpci(dst),
  };
}

export function telegramFromGroupRead(
  destination: GroupAddressInput,
  opts: { source?: IndividualAddressInput; direction?: TelegramDirection } = {},
): Telegram {
  const dst = new GroupAddress(destination);
  return {
    destinationAddress: dst,
    sourceAddress: opts.source ? new IndividualAddress(opts.source) : ANY_SOURCE,
    direction: opts.direction ?? 'outgoing',
    payload: groupValueRead(),
    tpci: defaultTpci(dst),
  };
}

export function telegramFromGroupResponse(
  destination: GroupAddressInput,
  data: APDUValue,
  opts: { source?: IndividualAddressInput; direction?: TelegramDirection } = {},
): Telegram {
  const dst = new GroupAddress(destination);
  return {
    destinationAddress: dst,
    sourceAddress: opts.source ? new IndividualAddress(opts.source) : ANY_SOURCE,
    direction: opts.direction ?? 'outgoing',
    payload: groupValueResponse(data),
    tpci: defaultTpci(dst),
  };
}

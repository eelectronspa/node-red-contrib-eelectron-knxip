// KNX address types: IndividualAddress (e.g. "1.2.3") and GroupAddress
// (e.g. "1/2/3", "1/123", or free "1234"). Both serialize to a 2-byte big-endian
// uint16 on the wire — the bit layout differs by type.

export class CouldNotParseAddress extends Error {
  constructor(
    public readonly address: unknown,
    message: string,
  ) {
    super(`Could not parse address ${JSON.stringify(address)}: ${message}`);
    this.name = 'CouldNotParseAddress';
  }
}

const U16_MAX = 0xffff;

function readUint16BE(buf: Buffer, offset = 0): number {
  if (buf.length < offset + 2) {
    throw new CouldNotParseAddress(buf, 'Buffer too short for address');
  }
  return buf.readUInt16BE(offset);
}

function writeUint16BE(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(value, 0);
  return buf;
}

export type IndividualAddressInput = IndividualAddress | string | number;
export type GroupAddressInput = GroupAddress | string | number;

export class IndividualAddress {
  static readonly MAX_AREA = 0x0f;
  static readonly MAX_MAIN = 0x0f;
  static readonly MAX_LINE = 0xff;
  private static readonly RE = /^(\d{1,2})\.(\d{1,2})\.(\d{1,3})$/;

  readonly raw: number;

  constructor(address: IndividualAddressInput) {
    this.raw = IndividualAddress.coerce(address);
  }

  private static coerce(address: IndividualAddressInput): number {
    if (address instanceof IndividualAddress) return address.raw;
    if (typeof address === 'number') {
      if (!Number.isInteger(address) || address < 0 || address > U16_MAX) {
        throw new CouldNotParseAddress(address, 'Address out of range (0..65535)');
      }
      return address;
    }
    if (typeof address === 'string') {
      if (/^\d+$/.test(address)) {
        const n = Number.parseInt(address, 10);
        if (n < 0 || n > U16_MAX) {
          throw new CouldNotParseAddress(address, 'Address out of range (0..65535)');
        }
        return n;
      }
      const m = IndividualAddress.RE.exec(address);
      if (!m) throw new CouldNotParseAddress(address, 'Invalid format');
      const area = Number.parseInt(m[1]!, 10);
      const main = Number.parseInt(m[2]!, 10);
      const line = Number.parseInt(m[3]!, 10);
      if (area > IndividualAddress.MAX_AREA) {
        throw new CouldNotParseAddress(address, `Area out of range (0..${IndividualAddress.MAX_AREA})`);
      }
      if (main > IndividualAddress.MAX_MAIN) {
        throw new CouldNotParseAddress(address, `Main out of range (0..${IndividualAddress.MAX_MAIN})`);
      }
      if (line > IndividualAddress.MAX_LINE) {
        throw new CouldNotParseAddress(address, `Line out of range (0..${IndividualAddress.MAX_LINE})`);
      }
      return (area << 12) | (main << 8) | line;
    }
    throw new CouldNotParseAddress(address, 'Invalid type');
  }

  static fromKnx(buf: Buffer, offset = 0): IndividualAddress {
    return new IndividualAddress(readUint16BE(buf, offset));
  }

  toKnx(): Buffer {
    return writeUint16BE(this.raw);
  }

  get area(): number {
    return (this.raw >> 12) & IndividualAddress.MAX_AREA;
  }

  get main(): number {
    return (this.raw >> 8) & IndividualAddress.MAX_MAIN;
  }

  get line(): number {
    return this.raw & IndividualAddress.MAX_LINE;
  }

  /** A device address (line != 0); line == 0 is a line/router address. */
  get isDevice(): boolean {
    return this.line !== 0;
  }

  equals(other: unknown): boolean {
    return other instanceof IndividualAddress && other.raw === this.raw;
  }

  toString(): string {
    return `${this.area}.${this.main}.${this.line}`;
  }
}

/**
 * Group address representation style. Affects only string formatting / parsing,
 * not the on-wire encoding (which is always a uint16).
 */
export type GroupAddressStyle = 'long' | 'short' | 'free';

export class GroupAddress {
  static readonly MAX_MAIN = 0x1f;
  static readonly MAX_MIDDLE = 0x07;
  static readonly MAX_SUB_LONG = 0xff;
  static readonly MAX_SUB_SHORT = 0x07ff;
  private static readonly RE = /^(\d{1,2})(?:\/(\d{1,2}))?\/(\d{1,4})$/;

  readonly raw: number;
  readonly style: GroupAddressStyle;

  constructor(address: GroupAddressInput, style: GroupAddressStyle = 'long') {
    this.style = style;
    this.raw = GroupAddress.coerce(address);
  }

  private static coerce(address: GroupAddressInput): number {
    if (address instanceof GroupAddress) return address.raw;
    if (typeof address === 'number') {
      if (!Number.isInteger(address) || address < 0 || address > U16_MAX) {
        throw new CouldNotParseAddress(address, 'Address out of range (0..65535)');
      }
      return address;
    }
    if (typeof address === 'string') {
      if (/^\d+$/.test(address)) {
        const n = Number.parseInt(address, 10);
        if (n < 0 || n > U16_MAX) {
          throw new CouldNotParseAddress(address, 'Address out of range (0..65535)');
        }
        return n;
      }
      const m = GroupAddress.RE.exec(address);
      if (!m) throw new CouldNotParseAddress(address, 'Invalid format');
      const main = Number.parseInt(m[1]!, 10);
      const middle = m[2] !== undefined ? Number.parseInt(m[2], 10) : null;
      const sub = Number.parseInt(m[3]!, 10);
      if (main > GroupAddress.MAX_MAIN) {
        throw new CouldNotParseAddress(address, `Main out of range (0..${GroupAddress.MAX_MAIN})`);
      }
      if (middle !== null) {
        if (middle > GroupAddress.MAX_MIDDLE) {
          throw new CouldNotParseAddress(address, `Middle out of range (0..${GroupAddress.MAX_MIDDLE})`);
        }
        if (sub > GroupAddress.MAX_SUB_LONG) {
          throw new CouldNotParseAddress(address, `Sub out of range (0..${GroupAddress.MAX_SUB_LONG})`);
        }
        return (main << 11) | (middle << 8) | sub;
      }
      if (sub > GroupAddress.MAX_SUB_SHORT) {
        throw new CouldNotParseAddress(address, `Sub out of range (0..${GroupAddress.MAX_SUB_SHORT})`);
      }
      return (main << 11) | sub;
    }
    throw new CouldNotParseAddress(address, 'Invalid type');
  }

  static fromKnx(buf: Buffer, offset = 0, style: GroupAddressStyle = 'long'): GroupAddress {
    return new GroupAddress(readUint16BE(buf, offset), style);
  }

  toKnx(): Buffer {
    return writeUint16BE(this.raw);
  }

  /** Main group, or `null` when style is 'free'. */
  get main(): number | null {
    if (this.style === 'free') return null;
    return (this.raw >> 11) & GroupAddress.MAX_MAIN;
  }

  /** Middle group, only meaningful when style is 'long'. */
  get middle(): number | null {
    if (this.style !== 'long') return null;
    return (this.raw >> 8) & GroupAddress.MAX_MIDDLE;
  }

  get sub(): number {
    if (this.style === 'short') return this.raw & GroupAddress.MAX_SUB_SHORT;
    if (this.style === 'long') return this.raw & GroupAddress.MAX_SUB_LONG;
    return this.raw;
  }

  equals(other: unknown): boolean {
    return other instanceof GroupAddress && other.raw === this.raw;
  }

  toString(): string {
    if (this.style === 'long') return `${this.main}/${this.middle}/${this.sub}`;
    if (this.style === 'short') return `${this.main}/${this.sub}`;
    return `${this.sub}`;
  }
}

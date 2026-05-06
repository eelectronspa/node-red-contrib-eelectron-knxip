// Host Protocol Address Information — 8 bytes describing how to reach a host:
//   [0]    structure length (always 0x08)
//   [1]    host protocol (0x01 IPv4/UDP, 0x02 IPv4/TCP)
//   [2..5] IPv4 address (network order)
//   [6..7] port (uint16 BE)
//
// "Route back" mode = 0.0.0.0:0 — tells the gateway to reply on the source IP/port
// of the request packet (NAT-friendly).

import { CouldNotParseKNXIP } from './errors';
import { HostProtocol } from './serviceTypes';

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4ToBytes(ip: string): Buffer {
  const m = IPV4_RE.exec(ip);
  if (!m) throw new TypeError(`Invalid IPv4 address: ${ip}`);
  const out = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    const oct = Number.parseInt(m[i + 1]!, 10);
    if (oct < 0 || oct > 255) throw new TypeError(`Invalid IPv4 address: ${ip}`);
    out[i] = oct;
  }
  return out;
}

function bytesToIpv4(buf: Buffer, offset: number): string {
  return `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`;
}

export class HPAI {
  static readonly LENGTH = 0x08;

  ip: string;
  port: number;
  protocol: HostProtocol;

  constructor(ip = '0.0.0.0', port = 0, protocol: HostProtocol = HostProtocol.IPV4_UDP) {
    if (!Number.isInteger(port) || port < 0 || port > 0xffff) {
      throw new TypeError(`Invalid port: ${port}`);
    }
    // Validate IP eagerly so misuse is caught at construction time.
    ipv4ToBytes(ip);
    this.ip = ip;
    this.port = port;
    this.protocol = protocol;
  }

  /** Empty HPAI (0.0.0.0:0). The gateway will reply on the source endpoint of the packet. */
  static routeBack(protocol: HostProtocol = HostProtocol.IPV4_UDP): HPAI {
    return new HPAI('0.0.0.0', 0, protocol);
  }

  get isRouteBack(): boolean {
    return this.ip === '0.0.0.0' && this.port === 0;
  }

  static fromKnx(raw: Buffer, offset = 0): { hpai: HPAI; bytesRead: number } {
    if (raw.length - offset < HPAI.LENGTH) {
      throw new CouldNotParseKNXIP('buffer too short for HPAI');
    }
    if (raw[offset] !== HPAI.LENGTH) {
      throw new CouldNotParseKNXIP(`unexpected HPAI length 0x${raw[offset]!.toString(16)}`);
    }
    const protoByte = raw[offset + 1]!;
    if (protoByte !== HostProtocol.IPV4_UDP && protoByte !== HostProtocol.IPV4_TCP) {
      throw new CouldNotParseKNXIP(`unsupported HPAI protocol 0x${protoByte.toString(16)}`);
    }
    const protocol: HostProtocol = protoByte;
    const ip = bytesToIpv4(raw, offset + 2);
    const port = raw.readUInt16BE(offset + 6);
    return { hpai: new HPAI(ip, port, protocol), bytesRead: HPAI.LENGTH };
  }

  toKnx(): Buffer {
    const buf = Buffer.alloc(HPAI.LENGTH);
    buf[0] = HPAI.LENGTH;
    buf[1] = this.protocol;
    ipv4ToBytes(this.ip).copy(buf, 2);
    buf.writeUInt16BE(this.port, 6);
    return buf;
  }

  toString(): string {
    const proto = this.protocol === HostProtocol.IPV4_UDP ? 'udp' : 'tcp';
    return `${this.ip}:${this.port}/${proto}`;
  }
}

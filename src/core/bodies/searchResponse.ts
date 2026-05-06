// SEARCH_RESPONSE — gateway's reply to SEARCH_REQUEST. Layout:
//   HPAI (8)            control endpoint of the responding gateway
//   DIB device_info (54): structure_length=54, type=0x01, KNX medium,
//                         device status, individual address, project
//                         installation id, KNX serial (6), routing multicast
//                         (4), MAC (6), friendly name (30, null-terminated).
//   DIB supp_svc_families (variable): structure_length, type=0x02, then
//                         pairs of (family_id, version).
//
// We parse the device-info DIB best-effort and keep the rest of the DIBs as
// raw bytes — the discovery client only needs the friendly name + endpoint
// for the editor's gateway picker.

import { IndividualAddress } from '../address';
import { CouldNotParseKNXIP } from '../errors';
import { HPAI } from '../hpai';
import { ServiceType } from '../serviceTypes';

export interface DeviceInfoDIB {
  knxMedium: number;
  deviceStatus: number;
  individualAddress: IndividualAddress;
  projectInstallation: number;
  /** 6-byte KNX serial number as lowercase hex (no separators). */
  serial: string;
  /** Routing multicast address advertised by the device. */
  multicastAddress: string;
  /** MAC address as colon-separated lowercase hex. */
  macAddress: string;
  /** ISO-8859-1 friendly name (up to 30 characters, null-terminated on the wire). */
  friendlyName: string;
}

const DIB_DEVICE_INFO_LEN = 54;
const DIB_TYPE_DEVICE_INFO = 0x01;

function parseDeviceInfo(dib: Buffer): DeviceInfoDIB {
  if (dib.length < DIB_DEVICE_INFO_LEN) {
    throw new CouldNotParseKNXIP('Device info DIB shorter than 54 bytes');
  }
  if (dib[0] !== DIB_DEVICE_INFO_LEN || dib[1] !== DIB_TYPE_DEVICE_INFO) {
    throw new CouldNotParseKNXIP('Not a device-info DIB');
  }
  const individualAddress = IndividualAddress.fromKnx(dib, 4);
  const projectInstallation = dib.readUInt16BE(6);
  const serial = dib.subarray(8, 14).toString('hex');
  const mc = dib;
  const multicastAddress = `${mc[14]}.${mc[15]}.${mc[16]}.${mc[17]}`;
  const mac = dib.subarray(18, 24);
  const macAddress = [...mac].map((b) => b.toString(16).padStart(2, '0')).join(':');
  // friendly name: 30 bytes, null-terminated
  let nameEnd = 24;
  while (nameEnd < DIB_DEVICE_INFO_LEN && dib[nameEnd] !== 0) nameEnd += 1;
  const friendlyName = dib.subarray(24, nameEnd).toString('latin1');
  return {
    knxMedium: dib[2]!,
    deviceStatus: dib[3]!,
    individualAddress,
    projectInstallation,
    serial,
    multicastAddress,
    macAddress,
    friendlyName,
  };
}

export interface SearchResponseInit {
  controlEndpoint?: HPAI;
  deviceInfo?: DeviceInfoDIB | null;
  /** Trailing DIBs we don't model (e.g. supp_svc_families). Stored as bytes. */
  trailingDibs?: Buffer;
}

export class SearchResponse {
  static readonly SERVICE_TYPE = ServiceType.SEARCH_RESPONSE;

  controlEndpoint: HPAI;
  deviceInfo: DeviceInfoDIB | null;
  trailingDibs: Buffer;

  constructor(init: SearchResponseInit = {}) {
    this.controlEndpoint = init.controlEndpoint ?? HPAI.routeBack();
    this.deviceInfo = init.deviceInfo ?? null;
    this.trailingDibs = init.trailingDibs ?? Buffer.alloc(0);
  }

  calculatedLength(): number {
    return (
      HPAI.LENGTH + (this.deviceInfo ? DIB_DEVICE_INFO_LEN : 0) + this.trailingDibs.length
    );
  }

  static fromKnx(raw: Buffer, offset = 0): { body: SearchResponse; bytesRead: number } {
    let pos = offset;
    const { hpai, bytesRead: hpaiLen } = HPAI.fromKnx(raw, pos);
    pos += hpaiLen;

    let deviceInfo: DeviceInfoDIB | null = null;
    let trailingStart = pos;

    if (raw.length - pos >= DIB_DEVICE_INFO_LEN) {
      const len = raw[pos]!;
      const type = raw[pos + 1]!;
      if (type === DIB_TYPE_DEVICE_INFO && len === DIB_DEVICE_INFO_LEN) {
        try {
          deviceInfo = parseDeviceInfo(raw.subarray(pos, pos + len));
          pos += len;
          trailingStart = pos;
        } catch {
          // Tolerate a malformed device info — keep the rest as trailing bytes.
        }
      }
    }

    const trailing = Buffer.from(raw.subarray(trailingStart));
    return {
      body: new SearchResponse({
        controlEndpoint: hpai,
        deviceInfo,
        trailingDibs: trailing,
      }),
      bytesRead: hpaiLen + (deviceInfo ? DIB_DEVICE_INFO_LEN : 0) + trailing.length,
    };
  }

  toKnx(): Buffer {
    // Encoding is mostly for tests — discovery clients only parse responses.
    const parts: Buffer[] = [this.controlEndpoint.toKnx()];
    if (this.deviceInfo) parts.push(encodeDeviceInfo(this.deviceInfo));
    parts.push(this.trailingDibs);
    return Buffer.concat(parts);
  }
}

function encodeDeviceInfo(d: DeviceInfoDIB): Buffer {
  const buf = Buffer.alloc(DIB_DEVICE_INFO_LEN);
  buf[0] = DIB_DEVICE_INFO_LEN;
  buf[1] = DIB_TYPE_DEVICE_INFO;
  buf[2] = d.knxMedium & 0xff;
  buf[3] = d.deviceStatus & 0xff;
  d.individualAddress.toKnx().copy(buf, 4);
  buf.writeUInt16BE(d.projectInstallation, 6);
  Buffer.from(d.serial, 'hex').copy(buf, 8, 0, 6);
  const mc = d.multicastAddress.split('.').map((s) => Number.parseInt(s, 10));
  for (let i = 0; i < 4; i++) buf[14 + i] = mc[i] ?? 0;
  const mac = d.macAddress.split(':').map((s) => Number.parseInt(s, 16));
  for (let i = 0; i < 6; i++) buf[18 + i] = mac[i] ?? 0;
  Buffer.from(d.friendlyName, 'latin1').copy(buf, 24, 0, 30);
  return buf;
}

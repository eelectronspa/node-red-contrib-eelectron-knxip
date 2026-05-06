// Connection Request Information (CRI) — appears inside CONNECT_REQUEST.
// Layout for a tunnel CRI:
//   [0]    structure length (4 basic, 6 extended)
//   [1]    connection type (0x04 tunnel)
//   [2]    KNX layer (DATA_LINK_LAYER, RAW_LAYER, BUSMONITOR_LAYER) — tunnel only
//   [3]    reserved (0x00) — tunnel only
//   [4..5] requested individual address — extended tunnel only
//
// Non-tunnel CRIs (device-mgmt, etc.) only carry the 2-byte header.

import { IndividualAddress, type IndividualAddressInput } from './address';
import { CouldNotParseKNXIP } from './errors';
import { ConnectionType, TunnellingLayer } from './serviceTypes';

const CRI_BASIC_LENGTH = 2;
const CRI_TUNNEL_LENGTH = 4;
const CRI_TUNNEL_EXT_LENGTH = 6;

export interface CRIInit {
  connectionType?: ConnectionType;
  knxLayer?: TunnellingLayer;
  individualAddress?: IndividualAddressInput;
}

export class CRI {
  connectionType: ConnectionType;
  knxLayer: TunnellingLayer;
  individualAddress: IndividualAddress | null;

  constructor(init: CRIInit = {}) {
    this.connectionType = init.connectionType ?? ConnectionType.TUNNEL_CONNECTION;
    this.knxLayer = init.knxLayer ?? TunnellingLayer.DATA_LINK_LAYER;
    this.individualAddress =
      init.individualAddress != null ? new IndividualAddress(init.individualAddress) : null;
  }

  private get isTunnel(): boolean {
    return this.connectionType === ConnectionType.TUNNEL_CONNECTION;
  }

  calculatedLength(): number {
    if (!this.isTunnel) return CRI_BASIC_LENGTH;
    return this.individualAddress ? CRI_TUNNEL_EXT_LENGTH : CRI_TUNNEL_LENGTH;
  }

  static fromKnx(raw: Buffer, offset = 0): { cri: CRI; bytesRead: number } {
    const available = raw.length - offset;
    if (available < CRI_BASIC_LENGTH) throw new CouldNotParseKNXIP('CRI shorter than minimum');
    const length = raw[offset]!;
    if (available < length) throw new CouldNotParseKNXIP('CRI length exceeds buffer');
    if (length < CRI_BASIC_LENGTH) throw new CouldNotParseKNXIP('CRI length too small');
    const connectionType = raw[offset + 1] as ConnectionType;
    const cri = new CRI({ connectionType });
    if (cri.isTunnel) {
      if (length === CRI_TUNNEL_LENGTH) {
        cri.knxLayer = raw[offset + 2] as TunnellingLayer;
      } else if (length === CRI_TUNNEL_EXT_LENGTH) {
        cri.knxLayer = raw[offset + 2] as TunnellingLayer;
        cri.individualAddress = IndividualAddress.fromKnx(raw, offset + 4);
      } else {
        throw new CouldNotParseKNXIP(`CRI tunnel has wrong length ${length}`);
      }
    } else if (length !== CRI_BASIC_LENGTH) {
      throw new CouldNotParseKNXIP(`CRI non-tunnel has wrong length ${length}`);
    }
    return { cri, bytesRead: length };
  }

  toKnx(): Buffer {
    const length = this.calculatedLength();
    const buf = Buffer.alloc(length);
    buf[0] = length;
    buf[1] = this.connectionType;
    if (this.isTunnel) {
      buf[2] = this.knxLayer;
      buf[3] = 0x00; // reserved
      if (this.individualAddress) this.individualAddress.toKnx().copy(buf, 4);
    }
    return buf;
  }
}

// Connection Response Data (CRD) — same shape as CRI but for the response side.
//   [0]    length (2 basic, 4 tunnel)
//   [1]    connection type
//   [2..3] assigned individual address — tunnel only

const CRD_BASIC_LENGTH = 2;
const CRD_TUNNEL_LENGTH = 4;

export interface CRDInit {
  connectionType?: ConnectionType;
  individualAddress?: IndividualAddressInput;
}

export class CRD {
  connectionType: ConnectionType;
  individualAddress: IndividualAddress | null;

  constructor(init: CRDInit = {}) {
    this.connectionType = init.connectionType ?? ConnectionType.TUNNEL_CONNECTION;
    this.individualAddress =
      init.individualAddress != null ? new IndividualAddress(init.individualAddress) : null;
  }

  private get isTunnel(): boolean {
    return this.connectionType === ConnectionType.TUNNEL_CONNECTION;
  }

  calculatedLength(): number {
    return this.isTunnel ? CRD_TUNNEL_LENGTH : CRD_BASIC_LENGTH;
  }

  static fromKnx(raw: Buffer, offset = 0): { crd: CRD; bytesRead: number } {
    const available = raw.length - offset;
    if (available < CRD_BASIC_LENGTH) throw new CouldNotParseKNXIP('CRD shorter than minimum');
    const length = raw[offset]!;
    if (available < length) throw new CouldNotParseKNXIP('CRD length exceeds buffer');
    if (length < CRD_BASIC_LENGTH) throw new CouldNotParseKNXIP('CRD length too small');
    const connectionType = raw[offset + 1] as ConnectionType;
    const crd = new CRD({ connectionType });
    if (crd.isTunnel) {
      if (length !== CRD_TUNNEL_LENGTH) {
        throw new CouldNotParseKNXIP(`CRD tunnel has wrong length ${length}`);
      }
      crd.individualAddress = IndividualAddress.fromKnx(raw, offset + 2);
    } else if (length !== CRD_BASIC_LENGTH) {
      throw new CouldNotParseKNXIP(`CRD non-tunnel has wrong length ${length}`);
    }
    return { crd, bytesRead: length };
  }

  toKnx(): Buffer {
    const length = this.calculatedLength();
    const buf = Buffer.alloc(length);
    buf[0] = length;
    buf[1] = this.connectionType;
    if (this.isTunnel && this.individualAddress) this.individualAddress.toKnx().copy(buf, 2);
    return buf;
  }
}

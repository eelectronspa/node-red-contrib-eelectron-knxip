// CONNECT_RESPONSE body (xknx/knxip/connect_response.py).
//   [0] communication channel id
//   [1] status code
//   then, only on success:
//   HPAI data (8) | CRD (2 or 4)

import { CRD } from '../cri';
import { CouldNotParseKNXIP } from '../errors';
import { HPAI } from '../hpai';
import { ErrorCode, ServiceType } from '../serviceTypes';

export interface ConnectResponseInit {
  communicationChannelId?: number;
  statusCode?: ErrorCode;
  dataEndpoint?: HPAI;
  crd?: CRD;
}

export class ConnectResponse {
  static readonly SERVICE_TYPE = ServiceType.CONNECT_RESPONSE;

  communicationChannelId: number;
  statusCode: ErrorCode;
  dataEndpoint: HPAI;
  crd: CRD;

  constructor(init: ConnectResponseInit = {}) {
    this.communicationChannelId = init.communicationChannelId ?? 0;
    this.statusCode = init.statusCode ?? ErrorCode.E_NO_ERROR;
    this.dataEndpoint = init.dataEndpoint ?? HPAI.routeBack();
    this.crd = init.crd ?? new CRD();
  }

  calculatedLength(): number {
    return 2 + HPAI.LENGTH + this.crd.calculatedLength();
  }

  static fromKnx(raw: Buffer, offset = 0): { body: ConnectResponse; bytesRead: number } {
    const available = raw.length - offset;
    if (available < 2) throw new CouldNotParseKNXIP('CONNECT_RESPONSE too short');
    const channelId = raw[offset]!;
    const statusCode = raw[offset + 1]! as ErrorCode;

    if (statusCode !== ErrorCode.E_NO_ERROR) {
      // Error responses omit the HPAI/CRD per spec; consume only the 2 status bytes.
      return {
        body: new ConnectResponse({
          communicationChannelId: channelId,
          statusCode,
        }),
        bytesRead: 2,
      };
    }

    let pos = offset + 2;
    const hpai = HPAI.fromKnx(raw, pos);
    pos += hpai.bytesRead;
    const crd = CRD.fromKnx(raw, pos);
    pos += crd.bytesRead;
    return {
      body: new ConnectResponse({
        communicationChannelId: channelId,
        statusCode,
        dataEndpoint: hpai.hpai,
        crd: crd.crd,
      }),
      bytesRead: pos - offset,
    };
  }

  toKnx(): Buffer {
    if (this.statusCode !== ErrorCode.E_NO_ERROR) {
      return Buffer.from([this.communicationChannelId, this.statusCode]);
    }
    return Buffer.concat([
      Buffer.from([this.communicationChannelId, this.statusCode]),
      this.dataEndpoint.toKnx(),
      this.crd.toKnx(),
    ]);
  }
}

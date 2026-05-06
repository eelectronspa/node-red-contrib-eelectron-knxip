// CONNECT_REQUEST body (xknx/knxip/connect_request.py).
//   HPAI control (8) | HPAI data (8) | CRI (4 or 6)

import { CRI, type CRIInit } from '../cri';
import { HPAI } from '../hpai';
import { ServiceType } from '../serviceTypes';

export interface ConnectRequestInit {
  controlEndpoint?: HPAI;
  dataEndpoint?: HPAI;
  cri?: CRI | CRIInit;
}

export class ConnectRequest {
  static readonly SERVICE_TYPE = ServiceType.CONNECT_REQUEST;

  controlEndpoint: HPAI;
  dataEndpoint: HPAI;
  cri: CRI;

  constructor(init: ConnectRequestInit = {}) {
    this.controlEndpoint = init.controlEndpoint ?? HPAI.routeBack();
    this.dataEndpoint = init.dataEndpoint ?? HPAI.routeBack();
    this.cri = init.cri instanceof CRI ? init.cri : new CRI(init.cri);
  }

  calculatedLength(): number {
    return HPAI.LENGTH + HPAI.LENGTH + this.cri.calculatedLength();
  }

  static fromKnx(raw: Buffer, offset = 0): { body: ConnectRequest; bytesRead: number } {
    let pos = offset;
    const ctrl = HPAI.fromKnx(raw, pos);
    pos += ctrl.bytesRead;
    const dat = HPAI.fromKnx(raw, pos);
    pos += dat.bytesRead;
    const cri = CRI.fromKnx(raw, pos);
    pos += cri.bytesRead;
    return {
      body: new ConnectRequest({
        controlEndpoint: ctrl.hpai,
        dataEndpoint: dat.hpai,
        cri: cri.cri,
      }),
      bytesRead: pos - offset,
    };
  }

  toKnx(): Buffer {
    return Buffer.concat([
      this.controlEndpoint.toKnx(),
      this.dataEndpoint.toKnx(),
      this.cri.toKnx(),
    ]);
  }
}

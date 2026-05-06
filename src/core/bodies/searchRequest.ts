// SEARCH_REQUEST — discovery probe sent to the KNX/IP routing multicast
// group. Body is a single HPAI describing where the response should be sent
// (route-back is fine; the gateway will reply on the source endpoint).

import { HPAI } from '../hpai';
import { ServiceType } from '../serviceTypes';

export interface SearchRequestInit {
  controlEndpoint?: HPAI;
}

export class SearchRequest {
  static readonly SERVICE_TYPE = ServiceType.SEARCH_REQUEST;

  controlEndpoint: HPAI;

  constructor(init: SearchRequestInit = {}) {
    this.controlEndpoint = init.controlEndpoint ?? HPAI.routeBack();
  }

  calculatedLength(): number {
    return HPAI.LENGTH;
  }

  static fromKnx(raw: Buffer, offset = 0): { body: SearchRequest; bytesRead: number } {
    const { hpai, bytesRead } = HPAI.fromKnx(raw, offset);
    return {
      body: new SearchRequest({ controlEndpoint: hpai }),
      bytesRead,
    };
  }

  toKnx(): Buffer {
    return this.controlEndpoint.toKnx();
  }
}

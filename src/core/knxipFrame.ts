// Top-level KNX/IP frame: header + body. The body type is dispatched by the
// header's service-type field.
//
// `fromBody(body)` constructs a frame and auto-fills the header service type
// (from the body class's static SERVICE_TYPE) and total length.
//
// `fromKnx(data)` parses a complete UDP datagram. It expects exactly one frame
// per datagram (true for UDP); any trailing bytes are reported via bytesRead so
// the caller can detect protocol abuse.

import type { KNXIPBody } from './bodies';
import { ConnectRequest } from './bodies/connectRequest';
import { ConnectResponse } from './bodies/connectResponse';
import { ConnectionStateRequest } from './bodies/connectionStateRequest';
import { ConnectionStateResponse } from './bodies/connectionStateResponse';
import { DisconnectRequest } from './bodies/disconnectRequest';
import { DisconnectResponse } from './bodies/disconnectResponse';
import { SearchRequest } from './bodies/searchRequest';
import { SearchResponse } from './bodies/searchResponse';
import { SecureWrapper } from './bodies/secureWrapper';
import { SessionAuthenticate } from './bodies/sessionAuthenticate';
import { SessionRequest } from './bodies/sessionRequest';
import { SessionResponse } from './bodies/sessionResponse';
import { SessionStatus } from './bodies/sessionStatus';
import { TimerNotify } from './bodies/timerNotify';
import { TunnellingAck } from './bodies/tunnellingAck';
import { TunnellingRequest } from './bodies/tunnellingRequest';
import { CouldNotParseKNXIP, UnsupportedKNXIPService } from './errors';
import { KNXIPHeader } from './knxipHeader';
import { ServiceType } from './serviceTypes';

interface BodyClass {
  readonly SERVICE_TYPE: number;
}

export class KNXIPFrame {
  header: KNXIPHeader;
  body: KNXIPBody;

  private constructor(header: KNXIPHeader, body: KNXIPBody) {
    this.header = header;
    this.body = body;
  }

  /** Build a frame around a body; sets header service type and total length. */
  static fromBody(body: KNXIPBody): KNXIPFrame {
    const ctor = body.constructor as unknown as BodyClass;
    const totalLength = KNXIPHeader.LENGTH + body.calculatedLength();
    const header = new KNXIPHeader(ctor.SERVICE_TYPE, totalLength);
    return new KNXIPFrame(header, body);
  }

  /**
   * Parse a complete frame. Throws {@link UnsupportedKNXIPService} for service
   * types we don't implement (DESCRIPTION_*, ROUTING_*, SECURE_*, etc.) so the
   * transport can log-and-drop without treating them as parse errors.
   */
  static fromKnx(data: Buffer): { frame: KNXIPFrame; bytesRead: number } {
    const { header, bytesRead: headerBytes } = KNXIPHeader.fromKnx(data);

    if (header.totalLength > data.length) {
      throw new CouldNotParseKNXIP(
        `header total length ${header.totalLength} exceeds buffer ${data.length}`,
      );
    }

    const bodyOffset = headerBytes;
    const result = parseBody(header.serviceType, data, bodyOffset);
    return {
      frame: new KNXIPFrame(header, result.body),
      bytesRead: headerBytes + result.bytesRead,
    };
  }

  toKnx(): Buffer {
    return Buffer.concat([this.header.toKnx(), this.body.toKnx()]);
  }
}

function parseBody(
  serviceType: number,
  data: Buffer,
  offset: number,
): { body: KNXIPBody; bytesRead: number } {
  switch (serviceType) {
    case ServiceType.CONNECT_REQUEST:
      return ConnectRequest.fromKnx(data, offset);
    case ServiceType.CONNECT_RESPONSE:
      return ConnectResponse.fromKnx(data, offset);
    case ServiceType.CONNECTIONSTATE_REQUEST:
      return ConnectionStateRequest.fromKnx(data, offset);
    case ServiceType.CONNECTIONSTATE_RESPONSE:
      return ConnectionStateResponse.fromKnx(data, offset);
    case ServiceType.DISCONNECT_REQUEST:
      return DisconnectRequest.fromKnx(data, offset);
    case ServiceType.DISCONNECT_RESPONSE:
      return DisconnectResponse.fromKnx(data, offset);
    case ServiceType.SEARCH_REQUEST:
      return SearchRequest.fromKnx(data, offset);
    case ServiceType.SEARCH_RESPONSE:
      return SearchResponse.fromKnx(data, offset);
    case ServiceType.SECURE_WRAPPER:
      return SecureWrapper.fromKnx(data, offset);
    case ServiceType.SESSION_REQUEST:
      return SessionRequest.fromKnx(data, offset);
    case ServiceType.SESSION_RESPONSE:
      return SessionResponse.fromKnx(data, offset);
    case ServiceType.SESSION_AUTHENTICATE:
      return SessionAuthenticate.fromKnx(data, offset);
    case ServiceType.SESSION_STATUS:
      return SessionStatus.fromKnx(data, offset);
    case ServiceType.TIMER_NOTIFY:
      return TimerNotify.fromKnx(data, offset);
    case ServiceType.TUNNELLING_REQUEST:
      return TunnellingRequest.fromKnx(data, offset);
    case ServiceType.TUNNELLING_ACK:
      return TunnellingAck.fromKnx(data, offset);
    default:
      throw new UnsupportedKNXIPService(serviceType);
  }
}

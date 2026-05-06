// KNX/IP protocol constants. Numeric values come from the KNXnet/IP spec
// (section 2 - common); xknx/knxip/knxip_enum.py is the cross-reference.

/** KNXnet/IP header version (always 0x10 for the current spec). */
export const KNXNETIP_VERSION_10 = 0x10;

/** KNXnet/IP header is always 6 bytes. */
export const HEADER_SIZE_10 = 0x06;

/** Multicast address for KNXnet/IP routing. */
export const KNX_ROUTING_MULTICAST = '224.0.23.12';

/** Default UDP port. */
export const KNX_PORT = 3671;

/**
 * Service identifiers. The high byte names a service family
 * (0x02 core, 0x03 device-mgmt, 0x04 tunnelling, 0x05 routing, 0x09 secure).
 */
export const ServiceType = {
  // 0x02 Core
  SEARCH_REQUEST: 0x0201,
  SEARCH_RESPONSE: 0x0202,
  DESCRIPTION_REQUEST: 0x0203,
  DESCRIPTION_RESPONSE: 0x0204,
  CONNECT_REQUEST: 0x0205,
  CONNECT_RESPONSE: 0x0206,
  CONNECTIONSTATE_REQUEST: 0x0207,
  CONNECTIONSTATE_RESPONSE: 0x0208,
  DISCONNECT_REQUEST: 0x0209,
  DISCONNECT_RESPONSE: 0x020a,
  SEARCH_REQUEST_EXTENDED: 0x020b,
  SEARCH_RESPONSE_EXTENDED: 0x020c,
  // 0x03 Device Management
  DEVICE_CONFIGURATION_REQUEST: 0x0310,
  DEVICE_CONFIGURATION_ACK: 0x0311,
  // 0x04 Tunnelling
  TUNNELLING_REQUEST: 0x0420,
  TUNNELLING_ACK: 0x0421,
  TUNNELLING_FEATURE_GET: 0x0422,
  TUNNELLING_FEATURE_RESPONSE: 0x0423,
  TUNNELLING_FEATURE_SET: 0x0424,
  TUNNELLING_FEATURE_INFO: 0x0425,
  // 0x05 Routing
  ROUTING_INDICATION: 0x0530,
  ROUTING_LOST_MESSAGE: 0x0531,
  ROUTING_BUSY: 0x0532,
  ROUTING_SYSTEM_BROADCAST: 0x0533,
  // 0x09 Secure
  SECURE_WRAPPER: 0x0950,
  SESSION_REQUEST: 0x0951,
  SESSION_RESPONSE: 0x0952,
  SESSION_AUTHENTICATE: 0x0953,
  SESSION_STATUS: 0x0954,
  TIMER_NOTIFY: 0x0955,
} as const;

export type ServiceType = (typeof ServiceType)[keyof typeof ServiceType];

/** Connection types used in CONNECT_REQUEST CRI. */
export const ConnectionType = {
  DEVICE_MGMT_CONNECTION: 0x03,
  TUNNEL_CONNECTION: 0x04,
  REMLOG_CONNECTION: 0x06,
  REMCONF_CONNECTION: 0x07,
  OBJSVR_CONNECTION: 0x08,
} as const;

export type ConnectionType = (typeof ConnectionType)[keyof typeof ConnectionType];

/** KNX layer for tunnelling connections. */
export const TunnellingLayer = {
  /** Standard cEMI link layer — what we use for normal tunneling. */
  DATA_LINK_LAYER: 0x02,
  RAW_LAYER: 0x04,
  BUSMONITOR_LAYER: 0x80,
} as const;

export type TunnellingLayer = (typeof TunnellingLayer)[keyof typeof TunnellingLayer];

/** Host protocol code in HPAI. */
export const HostProtocol = {
  IPV4_UDP: 0x01,
  IPV4_TCP: 0x02,
} as const;

export type HostProtocol = (typeof HostProtocol)[keyof typeof HostProtocol];

/** Status / error codes shared across KNX/IP responses. */
export const ErrorCode = {
  E_NO_ERROR: 0x00,
  E_HOST_PROTOCOL_TYPE: 0x01,
  E_VERSION_NOT_SUPPORTED: 0x02,
  E_SEQUENCE_NUMBER: 0x04,
  E_ERROR: 0x0f,
  E_CONNECTION_ID: 0x21,
  E_CONNECTION_TYPE: 0x22,
  E_CONNECTION_OPTION: 0x23,
  E_NO_MORE_CONNECTIONS: 0x24,
  E_NO_MORE_UNIQUE_CONNECTIONS: 0x25,
  E_DATA_CONNECTION: 0x26,
  E_KNX_CONNECTION: 0x27,
  E_AUTHORISATION_ERROR: 0x28,
  E_TUNNELLING_LAYER: 0x29,
  E_NO_TUNNELLING_ADDRESS: 0x2d,
  E_CONNECTION_IN_USE: 0x2e,
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const ERROR_CODE_NAMES = Object.fromEntries(
  Object.entries(ErrorCode).map(([k, v]) => [v, k]),
) as Record<number, string>;

export function errorCodeName(code: number): string {
  return ERROR_CODE_NAMES[code] ?? `UNKNOWN_0x${code.toString(16).padStart(2, '0')}`;
}

const SERVICE_TYPE_NAMES = Object.fromEntries(
  Object.entries(ServiceType).map(([k, v]) => [v, k]),
) as Record<number, string>;

export function serviceTypeName(type: number): string {
  return SERVICE_TYPE_NAMES[type] ?? `UNKNOWN_0x${type.toString(16).padStart(4, '0')}`;
}

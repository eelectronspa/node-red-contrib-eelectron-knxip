// I/O layer constants. Most timeouts mirror the KNX/IP spec (xknx/io/const.py),
// with one deliberate divergence: HEARTBEAT_RATE_MS is 20s instead of xknx's 70s
// so we detect dead tunnels much faster.

/** Default KNX/IP UDP port. */
export const KNX_PORT = 3671;

/** Default multicast group for KNX/IP routing. */
export const KNX_MULTICAST_GROUP = '224.0.23.12';

/** Default individual address used when the gateway doesn't assign one. */
export const DEFAULT_INDIVIDUAL_ADDRESS = '15.15.250';

/**
 * Connection alive time advertised by KNX/IP gateways (per spec).
 * After this much silence, a gateway will tear down a tunnel.
 */
export const CONNECTION_ALIVE_TIME_MS = 120_000;

/** Timeout awaiting CONNECTIONSTATE_RESPONSE after CONNECTIONSTATE_REQUEST. */
export const CONNECTIONSTATE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Cadence of heartbeat CONNECTIONSTATE_REQUESTs. xknx uses 70s; we use 20s for
 * faster failure detection. With a 10s timeout this still allows multiple retries
 * inside the gateway's 120s alive window.
 */
export const HEARTBEAT_RATE_MS = 20_000;

/** Tunnelling-request ACK timeout (per spec). */
export const TUNNELLING_REQUEST_TIMEOUT_MS = 1_000;

/** CONNECT_REQUEST / DISCONNECT_REQUEST timeout. */
export const CONNECT_REQUEST_TIMEOUT_MS = 10_000;

/** Default delay between auto-reconnect attempts. */
export const AUTO_RECONNECT_WAIT_MS = 3_000;

/** Maximum consecutive heartbeat failures before declaring the tunnel lost. */
export const HEARTBEAT_MAX_FAILURES = 4;

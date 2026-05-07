// KNX/IP body re-exports + the discriminated-by-class union used by KNXIPFrame.

export { ConnectRequest } from './connectRequest';
export { ConnectResponse } from './connectResponse';
export { ConnectionStateRequest } from './connectionStateRequest';
export { ConnectionStateResponse } from './connectionStateResponse';
export { DisconnectRequest } from './disconnectRequest';
export { DisconnectResponse } from './disconnectResponse';
export { SearchRequest } from './searchRequest';
export { SearchResponse } from './searchResponse';
export { SecureWrapper } from './secureWrapper';
export { SessionAuthenticate } from './sessionAuthenticate';
export { SessionRequest } from './sessionRequest';
export { SessionResponse } from './sessionResponse';
export { SecureSessionStatus, SessionStatus, secureSessionStatusName } from './sessionStatus';
export { TimerNotify } from './timerNotify';
export { TunnellingAck } from './tunnellingAck';
export { TunnellingRequest } from './tunnellingRequest';

import type { ConnectRequest } from './connectRequest';
import type { ConnectResponse } from './connectResponse';
import type { ConnectionStateRequest } from './connectionStateRequest';
import type { ConnectionStateResponse } from './connectionStateResponse';
import type { DisconnectRequest } from './disconnectRequest';
import type { DisconnectResponse } from './disconnectResponse';
import type { SearchRequest } from './searchRequest';
import type { SearchResponse } from './searchResponse';
import type { SecureWrapper } from './secureWrapper';
import type { SessionAuthenticate } from './sessionAuthenticate';
import type { SessionRequest } from './sessionRequest';
import type { SessionResponse } from './sessionResponse';
import type { SessionStatus } from './sessionStatus';
import type { TimerNotify } from './timerNotify';
import type { TunnellingAck } from './tunnellingAck';
import type { TunnellingRequest } from './tunnellingRequest';

export type KNXIPBody =
  | ConnectRequest
  | ConnectResponse
  | ConnectionStateRequest
  | ConnectionStateResponse
  | DisconnectRequest
  | DisconnectResponse
  | SearchRequest
  | SearchResponse
  | SecureWrapper
  | SessionAuthenticate
  | SessionRequest
  | SessionResponse
  | SessionStatus
  | TimerNotify
  | TunnellingRequest
  | TunnellingAck;

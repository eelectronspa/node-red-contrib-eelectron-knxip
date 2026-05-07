# Changelog

All notable user-facing changes are documented here. Entries follow the
"keep a changelog" style with semantic versioning.

## [0.8.0] — 2026-05-07

### Added
- **KNX/IP Secure tunneling over TCP** — full handshake (X25519 ECDH,
  AES-128-CMAC, AES-128-CCM, AES-128-CTR + CBC-MAC) per the KNX/IP
  Secure spec §2.5–§4.5. Verified end-to-end against a real EAE IP
  Secure interface.
- **ETS `.knxproj` parser** — parses ETS6 archives, including password-
  protected projects (two-stage ETS6 PBKDF2 + WinZip AES decryption).
  Extracts group addresses *and* the per-device security info
  (DeviceAuthenticationCode + tunnelling-user passwords).
- **"Fill from ETS project" button** on the tunnel-config dialog —
  enables KNX/IP Secure, picks an interface and a tunnelling user,
  and auto-fills gateway IP, user ID, device-auth password, and user
  password. Passwords are written to Node-RED's encrypted credentials
  file, never to `flows.json`.
- **`eelectron-knxip-ets-inject`** — new inject node with a GA picker
  populated from the bound ETS config. Payload hint adapts to the
  selected GA's DPT family.
- **Live bus-monitor sidebar** — new "KNX/IP" tab on the editor's
  right-hand sidebar streams every received telegram over Server-Sent
  Events and renders them in a scrolling table. Decodes values against
  any loaded ETS project (with units) and exposes a free-text filter
  (matches GA, source IA, name, DPT, hex, decoded value).

  ![Group monitor](images/group-monitor.png)

### Fixed
- `SESSION_AUTHENTICATE` is now wrapped in a `SECURE_WRAPPER` per spec
  §2.5.6 (used to be sent plain — gateways replied
  `SESSION_STATUS=TIMEOUT` for misleading reasons).
- `SESSION_REQUEST` and post-auth `CONNECT_REQUEST` now use the TCP host
  protocol byte (`0x02`) in their HPAIs instead of UDP — gateways
  silently dropped the previous frames.
- Inbound `TUNNELLING_REQUEST` sequence counter is now ignored over TCP
  (spec §4.4). Used to gate every telegram after the first as a
  duplicate, so only the first telegram surfaced in the bus.
- `DISCONNECT_REQUEST` no longer holds shutdown for a 10 s timeout —
  races the response against transport-close and uses a tighter 3 s
  ceiling on TCP, since most gateways disconnect by closing the socket
  without sending a response.

### Other
- Dialog status / toast text now reads **"Click Update/Add"** to match
  Node-RED's button labels (the button says *Add* for a new node and
  *Update* for an existing one).
- Two new sidebar-icon assets (`sidebar-logo-small-light.svg` /
  `-dark.svg`) for the bus-monitor tab. The tab uses the dark glyph by
  default; swap to the white variant manually if your theme needs it.

## Earlier releases

For pre-0.8.0 changes, see the GitHub releases page:
<https://github.com/eelectronspa/node-red-contrib-eelectron-knxip/releases>

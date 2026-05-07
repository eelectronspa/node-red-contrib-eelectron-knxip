# Changelog

All notable user-facing changes are documented here. Entries follow the
"keep a changelog" style with semantic versioning.

## [0.8.2] — 2026-05-07

### Added
- **More DPT subtypes and families.** New families: **DPT 26** (scene
  info, 1-byte combined active+number), **DPT 28** (UTF-8 string,
  variable length, NUL-terminated), **DPT 29** (8-byte signed integer
  for high-precision active/apparent/reactive energy totals, BigInt
  values). Plus ~25 new subtypes filling in DPT 5/8/9/13/14 (`5.006`
  tariff, `8.003`/`.004` delta-time, `8.012` length, several `9.x`
  meteorological and engineering units, `13.016` active-energy MWh,
  ~15 new `14.x` engineering subtypes including `14.058` pressure and
  `14.069` temperature_K). 158 specific DPT IDs are now registered
  across 25 families.

## [0.8.1] — 2026-05-07

### Added
- **Live bus-monitor sidebar** — new "KNX/IP" tab on the editor's
  right-hand sidebar streams every received telegram over Server-Sent
  Events and renders them in a scrolling table. Decodes values against
  any loaded ETS project (with units), and exposes a free-text filter
  matching across GA, source IA, name, DPT, hex, and decoded value.

  ![Group monitor](images/group-monitor.png)

- Two sidebar-icon assets (`sidebar-logo-small-light.svg` /
  `-dark.svg`) for the new tab.

### Fixed
- Inbound `TUNNELLING_REQUEST` sequence counter is now ignored over TCP
  (spec §4.4). Used to gate every telegram after the first as a
  duplicate, so only the first telegram surfaced. Outbound requests
  also hold seq=0 over TCP, matching the same spec section.
- `DISCONNECT_REQUEST` no longer holds shutdown for a 10 s timeout —
  races the response against transport-close and uses a tighter 3 s
  ceiling on TCP, since most gateways disconnect by simply closing
  the socket without sending a response.
- Object-valued DPTs (DPT 10 Time, DPT 11 Date, …) render as JSON in
  the bus monitor instead of the useless `[object Object]`.
- GA + name copy as a single line with a real space separator
  (`"1/1/29 Time"` rather than `"1/1/29Time"`).
- Removed a stray green panel rect from `KNX_logo.svg` that bled through
  on dark themes.

### Other
- Tunnel-config dialog status / ETS parse toast text now reads
  **"Click Update/Add"** to match Node-RED's button labels (the button
  says *Add* for a new node and *Update* for an existing one).
- `images/` and `CHANGELOG.md` added to the npm `files` allowlist so
  the README screenshot and changelog ship on the registry too.

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

### Fixed
- `SESSION_AUTHENTICATE` is now wrapped in a `SECURE_WRAPPER` per spec
  §2.5.6 (used to be sent plain — gateways replied
  `SESSION_STATUS=TIMEOUT` for misleading reasons).
- `SESSION_REQUEST` and post-auth `CONNECT_REQUEST` now use the TCP host
  protocol byte (`0x02`) in their HPAIs instead of UDP — gateways
  silently dropped the previous frames.

## Earlier releases

For pre-0.8.0 changes, see the GitHub releases page:
<https://github.com/eelectronspa/node-red-contrib-eelectron-knxip/releases>

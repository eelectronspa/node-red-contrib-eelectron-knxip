# Changelog

All notable user-facing changes are documented here. Entries follow the
"keep a changelog" style with semantic versioning.

## [0.9.1] — 2026-05-10

### Added
- **`eelectron-knxip-mqtt-publish` now decodes payloads via the ETS
  project's DPT.** Previously the node forwarded whatever the upstream
  listener emitted, which — when the listener had no DPT pinned —
  meant raw APDU shapes like `{ kind: 'bytes', value: <Buffer> }`
  reached the broker. The publish node already knows the per-GA DPT
  from the bound ETS Project config, so it now uses
  `getDpt(entry.dpt).decode(...)` to turn those raw APDUs into
  primitives (e.g. DPT 9.001 → `25`, DPT 1.001 → `true`) before
  building the MQTT message. Applies to all three payload modes
  (`value`, `object`, `template`). On unknown DPT or decode failure
  it falls back to the raw APDU and logs a warning, mirroring the
  listener's behavior.

### Changed
- **`Device authentication password` is now optional** in the
  `eelectron-knxip-config` Secure section. Many non-ETS interfaces
  (vendor-only web UIs) only expose a single tunnel password and do
  not surface the Device Authentication Code. Leaving the field blank
  is now supported: the SESSION_RESPONSE MAC check is skipped (with a
  warning logged), the encrypted session and SESSION_AUTHENTICATE
  user-password check still apply. ETS-keyring users are unaffected
  — when the field is filled, the MAC is verified as before.
- **Secure tunnel form rewritten for clarity.** The required
  `User pw` field now appears before the optional `Device auth pw`
  field and is marked with a red `*`. Placeholders explain each
  field's role; an inline banner above the password rows explains the
  two configuration modes (ETS-managed vs. single-password device).
  The help panel mirrors the same structure. No saved-data migration
  needed — only field order and labels changed.

### Fixed
- Removed a startup gate that refused to construct the secure tunnel
  when `deviceAuthPassword` was empty, even though the code path now
  supports that case.

## [0.9.0] — 2026-05-07

### Added
- **`eelectron-knxip-watchdog` node** — watches a list of group
  addresses and fires an `alarm` message when one of them has been
  silent longer than the configured timeout, and a `recovery` message
  when it speaks again. Optional ETS-config binding adds the GA name
  to the alarm payload and the sidebar status. Default check cadence
  is `timeout / 5` clamped to 5–60 s; "seed at deploy" prevents an
  immediate alarm flood the moment the flow starts. Example flow 16
  shows the typical wiring (watchdog → switch → alarm/recovery debug
  outputs).
- **`eelectron-knxip-dedupe` node** — drops repeat `(topic, payload)`
  pairs that arrive within a configurable window. Treats objects as
  equal when they canonicalise to the same JSON regardless of key
  order, so structured DPTs (DPT 10 time, DPT 11 date, DPT 232 RGB)
  dedupe correctly. Useful for cleaning a noisy listener and
  breaking write → listener feedback loops.
- **`eelectron-knxip-rate-limit` node** — caps msgs/window per topic
  via a sliding-window counter. Default strategy is plain
  drop-when-over; optional second output exposes the dropped messages
  for logging or alarming.
- Example flow 17 shows both filters wired on listener output (clean
  stream) and on a writer input (outbound throttle with drop output).
- **Generate-starter-flow button** in the ETS config dialog —
  populates a fresh tab with one shared "all-from-ETS" listener →
  debug node, one shared writer, and one core `inject` node per
  group address (pre-filled with `topic = GA`, wired to the writer).
  When the workspace has multiple tunnel-config nodes, an inline
  picker asks which to bind to. Saves a lot of clicking on a
  freshly-imported project; users prune from there.
- **Per-tunnel diagnostics**. `TunnelClient` now keeps live counters
  (TX / RX telegrams, heartbeat OK / failed, reconnects, last-frame
  timestamps, connected-at) accessible via the new
  `getDiagnostics()` method, exposed at admin endpoint
  `GET /eelectron-knxip/diagnostics`, and rendered as a strip above
  the bus-monitor sidebar table — one line per tunnel showing
  state, gateway, transport (UDP / TCP / TCP+SEC), assigned IA,
  rx/tx counts, queue depth, heartbeat OK/fail, reconnect count,
  idle time, and uptime. Polls every 2 s.
- **`eelectron-knxip-mqtt-publish` node** — bridges KNX listener
  output to an `mqtt out` downstream. Filters by ETS-project
  membership (only forwards GAs known to the bound project),
  reshapes the message into `{topic, payload}` with a configurable
  topic template (`{ga}` / `{gaName}` / `{dpt}` / `{source}` /
  `{ts}`) and a payload mode (`value-only`, built-in `object`, or a
  full JSON template — pure-placeholder strings preserve typing,
  embedded ones interpolate as text). Strips every other inbound
  field so internal KNX details don't leak to the broker.
- **"Generate KNX → MQTT bridge" button** in the ETS config dialog
  — second scaffolder. Pops up a checkbox modal listing every
  `eelectron-knxip-config` in the workspace; pick which tunnels feed
  the bridge and the generator drops a fresh tab containing one
  all-from-ETS listener per picked tunnel, all wired into a single
  mqtt-publish node, then into an `mqtt out` stub for you to point
  at your broker.
- **`eelectron-knxip-schedule` node** — fires a configured payload
  to a chosen GA on a 5-field cron expression (with `*`, ranges,
  lists, and steps) or a fixed interval. Output shape matches
  `ets-inject` so it pipes straight into a writer with the same
  ETS config bound — no encoder node needed. Includes manual
  fire-on-deploy and a per-node fire counter in the status
  footer. Example flow 18 shows both modes.

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

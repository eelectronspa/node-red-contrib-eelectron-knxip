# node-red-contrib-eelectron-knxip

Stable Node-RED nodes for KNX/IP — UDP tunneling, **KNX/IP Secure tunneling
over TCP**, ETS-driven DPT auto-encoding, gateway discovery, a live bus
monitor in the editor sidebar, and a small set of typed convenience
encoders for everyday KNX traffic.

![KNX/IP bus monitor sidebar](images/group-monitor.png)

## Highlights

- **Stable tunnel client** — clean state machine, heartbeat, auto-reconnect,
  duplicate-suppression, multi-tunnel safe (one config = one socket = one
  channel; many configs run side-by-side).
- **KNX/IP Secure** — full handshake (X25519 ECDH, AES-CMAC, AES-CCM) over
  TCP per spec §2.5–§4.5, verified end-to-end against real interfaces.
  Credentials autofill from a `.knxproj` (project password + per-user
  passwords decrypted on the server, stored encrypted at rest in
  Node-RED's credentials file — never in `flows.json`).
- **Live bus monitor** — sidebar tab streams every received telegram in
  real time over Server-Sent Events. Decodes against any loaded ETS
  project, shows source IA, GA + name, APCI kind, and a decoded value
  (with units). Filter by GA, name, DPT, hex, or value substring.
- **ETS-driven workflow** — load your group-address CSV (any of comma /
  semicolon / tab variants, with or without headers) or upload a full
  `.knxproj` (password-protected ETS6 archives supported); the listener,
  writer, and bus monitor all auto-pick the right DPT codec for each GA.
- **Gateway discovery** — *Discover* button in the tunnel-config dialog
  multicasts a SEARCH_REQUEST and lists devices on the LAN.
- **Editor autocomplete** — GA fields suggest from the bound ETS project
  (with name + DPT preview); DPT fields suggest from the codec registry.
- **Defensive primitives** — read-on-connect, anti-loop dedupe window,
  GA wildcards, "all from ETS" subscription, ETS translator with raw
  passthrough output for custom decoding.

## Nodes

### Connection / status
- `eelectron-knxip-config` — KNX/IP gateway connection settings (config node).
- `eelectron-knxip-status` — emits tunnel state, queue depth, last error.

### Bus I/O
- `eelectron-knxip-listener` — subscribe to group addresses (exact, wildcard,
  or "all from ETS"). Optional read-on-connect.
- `eelectron-knxip-writer` — `GroupValueWrite` / `GroupValueRead`. Optional
  ETS binding for automatic DPT lookup. Optional dedupe window.

### ETS project
- `eelectron-knxip-ets-config` — holds a parsed ETS project. Accepts either
  a CSV group-address export or a full `.knxproj` archive (password
  prompt for ETS6-encrypted projects). Surfaces the discovered KNX/IP
  Secure interfaces to the tunnel-config dialog so passwords can be
  filled with one click instead of copy-pasted out of ETS.
- `eelectron-knxip-ets` — translator: decodes APDUs to scalars or encodes
  scalars to APDUs based on `msg.topic` and the project map. Two outputs:
  decoded values + raw passthrough.
- `eelectron-knxip-ets-inject` — manual / scheduled inject node with a
  GA picker; payload hint adapts to the selected GA's DPT family.

### Convenience
- `eelectron-knxip-state-store` — caches the last value per GA, queryable
  by `msg.action = 'get' | 'list' | 'clear'`.
- `eelectron-knxip-scene` — typed encoder for DPT 17.001 / 18.001
  (scene number, scene control with activate/learn).
- `eelectron-knxip-color` — typed encoder for DPT 232.600 (RGB) /
  DPT 251.600 (RGBW). Accepts hex, `rgb()` / `rgba()`, or
  `{red, green, blue, white?}`.

## Supported DPTs

DPT 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 19, 20, 232,
235, 251 — covering boolean / step controls, scaled and raw integers, KNX
2-byte float, IEEE float, time, date, date+time, characters and strings,
scene control, energy + tariff, RGB / RGBW.

Pass an unknown sub-type and the normalizer falls back to the family's
default sub (`DPT-7` → `7.001`, etc.); GAs whose DPT isn't yet in our
codec library route to the ETS translator's raw-passthrough output so a
function node can handle them.

## Examples

After installing, find ready-to-import flows in Node-RED at
**Import → Examples → node-red-contrib-eelectron-knxip**:

- 01 Tunnel status
- 02 Raw bus monitor
- 03 Decoded bus monitor (ETS)
- 04 Switch control (DPT1)
- 05 Dimmer control (DPT5 / DPT3)
- 06 Custom decoder for output 2
- 07 Writer with ETS auto-encode (no translator needed)
- 08 State store cache (listener → cache → query by GA)
- 09 Scene control (DPT 17 / 18)
- 10 Colour control (DPT 232 / 251 — hex / `rgb()` / object)
- 11 Full project monitor (all GAs from ETS + read-on-connect)
- 12 Anti-loop dedupe demo
- 13 KNX/IP Secure tunnel + decoded bus monitor
- 14 ETS-aware inject node (pick GA from project)
- 15 Secure write through ETS-inject + writer

## Development

```bash
npm install
npm run build
npm test
```

## Releasing

Tagged commits trigger the **Release** GitHub Action, which builds the package
and attaches the `.tgz` to a fresh GitHub Release. The release notes come from
the **annotated tag message**, so you control them at tag time:

```bash
# 1. Bump version in package.json (creates a commit + a v* tag locally)
npm version patch        # or `minor` / `major`

# 2. Replace the auto-generated tag with an annotated one carrying release notes
git tag -d v0.5.1
git tag -a v0.5.1 -m "Release v0.5.1

- short bullet list of user-facing changes
- another change
"

# 3. Push commits and tag
git push --follow-tags
```

If you don't care about a hand-written changelog and want GitHub's auto-generated
commit list back, flip `generate_release_notes` to `true` in
`.github/workflows/release.yml`.

The workflow refuses to publish if the tag and `package.json` version disagree,
so you can safely use `npm version` (which keeps them aligned) or hand-edit
both — just don't let them drift.

The **CI** workflow runs tests on every push and pull request against
`main` across Node.js 18 / 20 / 22.

`npm run build` compiles TypeScript to `dist/` and copies HTML / SVG assets
next to each node module. `npm pack` produces a `.tgz` you can drop into
Node-RED's Palette → Install → Upload tab.

## License

[Apache License 2.0](./LICENSE). See [NOTICE](./NOTICE) for trademark
information — the **eelectron** brand and the package name are not granted
under the Apache license. Forks intended for redistribution must use a
different name.

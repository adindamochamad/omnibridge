# Changelog

All notable changes to OmniBridge are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions use
[Semantic Versioning](https://semver.org/).

## [0.3.1] — 2026-10-27

Judge-facing commit gate.

### Added
- `/hackathon` default: Modbus with **broken CRC** so naive commits while verified holds on the same bytes
- Gate chips on the live buffer (held / naive / passed)
- Tool-call list on the compare page
- Compare page shows buffer CRC against 0.90, model confidence beside the tool CRC, and whether command presets would be sent or withheld
- `/hackathon` is a comparison sheet in the desktop window: one CRC readout, the byte tape, then naive and verified on the same grid
- Verified hold also catches a Modbus-shaped parser whose title omits the word Modbus
- Compare run refuses `send_bytes` before an approval dialog, and a hold keeps the refused command names off the installed parser
- Meta client sends the key as a bearer token to `https://api.meta.ai/v1/messages`. The previous base URL doubled `/v1`, and Meta answered `invalid_api_key`
- An Anthropic key left in the old settings field is no longer sent to Meta. The compare page asks for a Standard key from dev.meta.ai (`LLM_`)

### Changed
- App subtitle names the commit gate and Muse Spark, not the old CAS-only branding
- Commit gate page shows the hackathon caption and a live PLC faceplate decoded from the Modbus frame
- On-screen analysis, investigation, and chat copy names Muse Spark instead of Claude or Opus

## [0.3.0] — 2026-10-27

Meta Global AI Developer Hackathon 2026 (Indie · Push the Frontier).

### Added
- **Commit gate** — verified investigation withholds parser fields, dashboard, and learned profiles until framing evidence matches (`src/lib/commit-gate.ts`)
- **Muse Spark 1.3** via Meta Model API (`https://api.meta.ai/v1`, Standard mode)
- **Side-by-side demo** at `/hackathon` (virtual CAS scale vs Modbus RTU)
- Settings + Test connection for Meta Model API keys

### Changed
- Agent and one-shot analysis no longer call Anthropic Claude Opus
- Naive Analyze still commits without evidence (explicit contrast lane)

## [0.2.0] — 2026-08-09

### Added
- **Webhook send filter** — optionally forward only when a parsed field equals a value (e.g. `stable=ST` on scales)
- **Webhook quick presets** — one-click templates for JSON (Zapier/n8n), legacy form POST, industrial scale, and Home Assistant
- **Device profile export/import** — share learned protocols between machines via JSON (Settings → Learned Data)
- **Webhook skipped counter** — tracks payloads blocked by the send filter
- Server error bodies now appear in webhook failure messages (up to 120 chars)

### Changed
- Webhook modal placeholders generalized (no vendor-specific field names)
- `User-Agent` bumped to `OmniBridge/0.2`

## [0.1.0] — 2026-04-27

Initial release for the Claude Opus 4.7 Hackathon 2026.

### Added
- **Cross-platform desktop app** built on Tauri 2, SvelteKit, Svelte 5 (runes), TypeScript, and Rust
- **Device discovery** with USB VID/PID classification (Arduino, FTDI, CH340, CP210x, generic USB serial, Bluetooth serial)
- **Live serial monitor** with ASCII + HEX views, timestamp, direction marker, and 1000-line ring buffer
- **Protocol Detective** — one-shot analysis powered by Claude Opus 4.7:
  - Structured JSON output with protocol name, confidence %, extracted fields, and command presets
  - Prompt caching on system prompt for ~70% cost reduction on repeat calls
  - Adaptive extended thinking for unknown / low-confidence cases
- **Agentic Investigation mode** — multi-step tool use:
  - `read_more_lines` — fetch recent samples
  - `search_pattern` — test ECMAScript regex hypotheses (ReDoS-guarded)
  - `analyze_binary_structure` — autocorrelate frame length, validate Modbus CRC16, count framing bytes
  - `get_device_metadata` — cross-reference USB descriptor fields
  - `probe_baud_rate` — test an alternate baud when data looks unprintable
  - `send_bytes` — transmit to the device to elicit responses
  - Live trace UI streams every thinking block, tool call, and result
- **Live Structured Dashboard** with sparklines
  - ASCII protocols: regex-based field extraction from `line.ascii`
  - Binary protocols: `match_hex` mode with `hex_u16_be` / `hex_u16_le` / `hex_s16_be` / `hex_u8` data types for fixed-offset extraction
  - Orange-themed cards distinguish binary-decoded fields from ASCII numbers
  - Stale indicator, value flash, per-field "last updated" timestamps
- **Device Profile Learning**
  - Every analysis with confidence ≥ 55% is persisted by `VID:PID:SerialNumber`
  - Reconnecting a learned device instantly populates the dashboard with zero API calls
  - `⭐ Auto-recognized` badge with session count
- **Bidirectional Communication**
  - Command Sender panel with ASCII (supports `\r \n \xNN` escapes) or HEX input
  - Claude-generated command presets appear as clickable chips per identified protocol
- **Cloud Bridge** — webhook forwarding
  - Per-device URL, method (POST/PUT/PATCH), throttle, and custom headers
  - `Test` button exercises the endpoint with a sample payload before enabling
  - HTTP/HTTPS URL validation; no SSRF guards (trusted desktop app)
- **CSV / JSON Export** — download the raw or structured stream for offline analysis
- **Demo Mode** (no hardware needed)
  - `⚖️ CAS Weighing Scale` — ASCII with stability flag (4 Hz)
  - `🛰️ GPS Receiver` — NMEA 0183 sentences with correct XOR checksums (1 Hz)
  - `🌡️ Arduino Sensor Array` — key=value CSV (2 Hz)
  - `🏭 Modbus RTU PLC` — binary frames with valid CRC16-IBM, 10 registers (1.7 Hz)

### Security
- API key storage via `@tauri-apps/plugin-store` (scoped to Tauri's app data directory)
- `VITE_ANTHROPIC_API_KEY` env fallback restricted to `import.meta.env.DEV` — release builds never embed the developer's key
- ReDoS guards reject regex patterns with nested quantifiers (`(a+)+`, `(a*)*`, etc.) and patterns over 300 characters
- Webhook URLs must use `http://` or `https://` protocol
- `send_bytes` tool capped at 256 bytes per call and requires an active monitor

### Developer experience
- 29 vitest unit tests covering parser, webhook URL validation, and the binary-analysis tool
- GitHub Actions CI: frontend (typecheck + tests + Vite build) and Rust (fmt + clippy + check)
- 0 TypeScript errors, 0 Svelte warnings on the full tree
- `friendlyError()` helper normalizes Anthropic SDK errors into short readable messages (401 → "API key rejected", 429 → "Rate limit hit", etc.)

### Documentation
- `README.md` with architecture diagram, "Why Opus 4.7" capability table, and full feature list
- `docs/DEMO_DRILL.md` — reproducible testing checklist for the Modbus agent flow
- `docs/DEMO_SCRIPT.md` — earlier pre-flight and recording checklist
- `docs/RELEASE_GUIDE.md` — how to produce signed DMG/MSI/AppImage artifacts
- `docs/RELEASE_NOTES_0.1.0.md` — release notes for the 0.1.0 tag

[0.2.0]: https://github.com/adindamochamad/omnibridge/releases/tag/v0.2.0
[0.1.0]: https://github.com/adindamochamad/omnibridge/releases/tag/v0.1.0

# OmniBridge

OmniBridge is a desktop application that reads a legacy serial stream and asks a model to identify the protocol. The agent can probe the baud rate and send bytes to the device.

Industrial scales, PLCs, and similar devices often speak serial protocols that are undocumented or that disagree with the vendor note. Recovering the frame format is usually manual. OmniBridge keeps a live byte buffer, lets an agent inspect it with tools, and can store a parser after the model commits one.

Version 0.1.0 was entered in the Claude Opus 4.7 hackathon in 2026. From version 0.3.0, this branch is the Meta Global AI Developer Hackathon 2026 build. Identification calls Muse Spark 1.3 on the Meta Model API. This repository does not record a ranking.

## Install and run

These commands were not re-executed for this README revision.

Requirements: Node.js 20 or newer, Rust, and the Tauri 2 system dependencies. Protocol identification also needs a Meta Model API Standard key from https://dev.meta.ai. The key starts with `LLM_` and is pasted in Settings. It is not stored in this repository.

```bash
npm install
npm run tauri dev
```

`npm test` runs the Vitest suite. `npm run tauri build` produces a desktop bundle. Without a Meta key the window can open, and protocol identification cannot.

Demo mode streams simulated CAS, GPS, Arduino, and Modbus devices, so the interface can be opened without hardware. The `/hackathon` page identifies an in-memory buffer and does not write to a USB port.

## What this does not do

- This branch does not call Claude or Anthropic. `src/lib/claude.ts` is the old filename. The client in `src/lib/meta-api.ts` uses `https://api.meta.ai`.
- The agent does not identify a protocol by probing alone. It reads captured bytes and may call `probe_baud_rate` or `send_bytes`. A send asks for approval first.
- The `/hackathon` page withholds those transmit tools. It is not a session against a physical port.
- This is a hackathon project. It is not a certified industrial integration. The naive comparison path can still commit a parser when the framing evidence is weak.

## License

MIT. See `LICENSE`.

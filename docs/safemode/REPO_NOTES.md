# Safe Mode — repo notes

Last verified on the **current working tree** after M3 (Safe Mode gate + approval). Baseline PRD commit was `075b35e`; line numbers below are from the post-M3 tree and drift with edits.

Locked decisions: [omnibridge-safe-mode-plan.md](./omnibridge-safe-mode-plan.md). PRD copy: [omnibridge-safe-mode-prd.md](./omnibridge-safe-mode-prd.md).

## §2.1 fact table (post-M3 line numbers)

| Area | Fact (file:lines) |
|------|---------------------|
| Stack | Tauri **2.10.3** (`src-tauri/Cargo.lock`). SvelteKit 2 + Svelte 5 + `@sveltejs/adapter-static`. TypeScript **~5.6.2**, Vite **^6.0.3**. Version **0.2.3** (`package.json`) vs **0.2.2** (`src-tauri/Cargo.toml`, `tauri.conf.json`) — leave mismatch per PRD. |
| Rust deps | `tauri`, `tauri-plugin-opener`, `tauri-plugin-serialplugin` 2.22.0, `tauri-plugin-store`, `serialport` 4.9.0, `serde`, `serde_json`, `reqwest` 0.12 (rustls), **`regex`** (Safe Mode policy). No direct `tokio`; approval wait uses `std::sync::mpsc` + `tauri::async_runtime::spawn_blocking`. No SQLite, no `[dev-dependencies]` in manifest. |
| Rust layout | `lib.rs`, `discovery.rs`, `main.rs`, **`safemode/`** (`mod.rs`, `policy.rs`, `rate_limit.rs`, `approval.rs`, **`gate.rs`**, `audit.rs` stub). |
| Serial write path | Shared **`write_to_port`** `lib.rs` **L38–56**. Human command **`send_bytes_to_port`** **L226–232** → `write_to_port`. Monitor thread TX `port:data` direction `tx` unchanged. |
| Tauri commands | `discover_devices`, `start_port_monitor`, `stop_port_monitor`, `probe_single_baud`, `send_bytes_to_port`, `send_webhook_request`, **`safemode_begin_session`**, **`safemode_authorize_tool`**, **`safemode_resolve_approval`**, **`safemode_agent_send_bytes`** (async). Registered **`generate_handler!`** **L450–461**. State: `MonitorRegistry` + **`SafeModeState`** (policy path in `.setup()` **L438–445**). |
| Agent tools | `src/lib/agent-tools.ts`: six tools; **`executeTool(name, input, ctx, toolUseId)`** **L137**. Every tool: **`safemode_authorize_tool`** first. **`send_bytes`** **L241+** → **`safemode_agent_send_bytes`** **L254** (not `send_bytes_to_port`). |
| Agent loop | `analyzeWithAgent` `claude.ts`: **`safemode_begin_session`** **~L568**; tool loop passes **`tu.id`** to `executeTool` **~L687–691**. SDK in WebView; model `claude-opus-4-7`; `MAX_AGENT_STEPS = 8`. Investigate from `DataBuffer.svelte`. |
| Approval UI | `ApprovalDialog.svelte` on `+page.svelte`; listens **`safemode:approval_requested`**; calls **`safemode_resolve_approval`**. Helpers `src/lib/safemode.ts`. |
| Other writes | **Command Sender** → `send_bytes_to_port` (human, not gated in v1). `probe_single_baud` uses `serialport` read path in `lib.rs`. |
| Capabilities | [`default.json`](../../src-tauri/capabilities/default.json): **`core:default`**, **`opener:default`**, **`store:default`** only — **`serialplugin:*` removed** (M2.4). **`tauri_plugin_serialplugin::init()`** still in `lib.rs` **~L448**; discovery/monitor use **`serialport`** crate, not plugin JS API (`rg serialplugin src` → empty). |
| Demo mode | `demo://` ports in frontend; gate returns **`simulated: true`** after policy + human approve (no Rust registry write). |
| Tests / CI | Vitest: `parser`, `profiles`, `agent-tools`, `webhook`, `cas-scale`, **`safemode`**. Rust: policy/gate/approval tests in `src-tauri/src/safemode/`, `write_to_port` tests in `lib.rs`. CI: `cargo fmt`, clippy `-D warnings`, **`cargo test`**, `npm run check`, `npm test`, `npm run build`. |
| CSP | `tauri.conf.json`: `"csp": null`. |

## Differences from original M0 snapshot

| Topic | M0 / PRD §2.1 | Post-M3 |
|-------|----------------|---------|
| Agent `send_bytes` | Direct `send_bytes_to_port` | Gated `safemode_agent_send_bytes` + approval dialog |
| `toolUseId` | Not wired | `tu.id` → gate |
| Capabilities | `serialplugin:default` + `allow-available-ports` | Removed; plugin `init()` remains |
| Safe Mode modules | Not present | `safemode/*` + `gate.rs` |

## M0.2 — `serialplugin` (reconfirmed after M2.4)

- **Frontend:** no `serialplugin` imports under `src/`.
- **Discovery / monitor / probe / Command Sender:** `serialport` + Tauri commands; writes via `write_to_port` / `send_bytes_to_port`.
- **`init()`:** still registered; dropping it not validated in this session.
- **Capabilities:** narrowed as above; no `serialplugin` permission grants.

## M0.3 — module layout in use

Approved M0 list **plus** (intentional; not in original M0 bullet list):

- **`src-tauri/src/safemode/gate.rs`** — Tauri commands, `SafeModeState`, policy/approval wiring, `write_to_port` after approve.

Unchanged roles:

- `mod.rs` — `PolicyEngine`
- `policy.rs`, `rate_limit.rs`, `approval.rs` — store + pending map (`take` / send bool outside outer mutex from command)
- `audit.rs` — stub (M4)
- `src/lib/safemode.ts`, `ApprovalDialog.svelte`; `AuditLogPanel.svelte` — not yet (M4)

Policy: `<app_config_dir>/safemode-policy.json`. Audit (planned): `<app_data_dir>/safemode-audit.jsonl`.

## Manual regression checklist

**Not run on real hardware in the session that updated this file.** Fill pass/fail when verified locally.

| Feature | M2 | M3 | Notes |
|---------|----|----|-------|
| Device discovery | | | `discover_devices` / `serialport` |
| Start/stop port monitor | | | |
| RX `port:data` display | | | |
| Command Sender write | | | `send_bytes_to_port` |
| Baud probe (port not monitored) | | | |
| Webhook forward | | | |
| Demo virtual port | | | |
| One-shot analysis | | | |
| Agent Investigate + Safe Mode gate | | | Approve/Deny dialog; no silent agent write |
| Approval timeout / queue | | | Two requests one dialog at a time |

# Safe Mode — repo notes (M0)

Verified against **HEAD** `075b35ea01b437fcdcea97f8c6118be73c6f71bf` (same baseline as PRD v2 §2.1). Line numbers below refer to this commit.

Locked implementation decisions live in [omnibridge-safe-mode-plan.md](./omnibridge-safe-mode-plan.md). Full PRD copy: [omnibridge-safe-mode-prd.md](./omnibridge-safe-mode-prd.md).

## §2.1 fact table (current line numbers)

| Area | Fact (file:lines) |
|------|---------------------|
| Stack | Tauri **2.10.3** (`src-tauri/Cargo.lock`). SvelteKit 2 + Svelte 5 + `@sveltejs/adapter-static` (`package.json`). TypeScript **~5.6.2**, Vite **^6.0.3**. App version **0.2.3** in `package.json` **0.2.2** in `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` (mismatch — leave as-is per PRD). |
| Rust deps | `src-tauri/Cargo.toml`: `tauri`, `tauri-plugin-opener`, `tauri-plugin-serialplugin` 2.22.0, `tauri-plugin-store` 2.4.2, `serialport` 4.9.0, `serde`, `serde_json`, `reqwest` 0.12 (rustls). **No direct `tokio`, no SQLite, no `[dev-dependencies]`** in manifest (`tokio` is transitive via Tauri in `Cargo.lock`). |
| Rust layout | `src-tauri/src/lib.rs`, `discovery.rs`, `main.rs`. Commands: `discover_devices` (L79–82), `start_port_monitor` (L84–197), `send_bytes_to_port` (L199–220), `probe_single_baud` (L292–311), `stop_port_monitor` (L313–323), `send_webhook_request` (L337–365). Registered in `run()` `generate_handler!` **L376–383**. State: `MonitorRegistry = Arc<Mutex<HashMap<String, PortRegistration>>>` (L35), `.manage(registry)` L372. |
| Serial write path | `send_bytes_to_port` pushes `Vec<u8>` on mpsc channel (L215–218). Monitor thread in `start_port_monitor` (spawn L113): `write_all` + `flush` L135–137, emits `port:data` with `direction: "tx"` L143–151. |
| Agent tools | `src/lib/agent-tools.ts`: `AGENT_TOOLS` six tools L7–101; `send_bytes` L67–85 (`hex`, `purpose`). |
| Tool dispatch | `executeTool` L115–…; `send_bytes` case **L204–231** calls `invoke('send_bytes_to_port', …)` **with no approval** (L217). 600 ms wait L220. |
| Agent loop | `analyzeWithAgent` `src/lib/claude.ts` **L545+**. Anthropic SDK in WebView `dangerouslyAllowBrowser: true` L145; model `claude-opus-4-7` L609; `MAX_AGENT_STEPS = 8` L543. Tool loop **L679–691** — `executeTool(tu.name, tu.input, toolCtx)` **does not pass `tu.id` yet** (M2.3). `SYSTEM_PROMPT_AGENT` L361+. Started from `DataBuffer.svelte` **L384** (“Investigate” UI L452–457). |
| Other writes | Human **Command Sender** `src/lib/CommandSender.svelte` **L83** → `send_bytes_to_port`. `probe_single_baud` opens port read-only in `probe_single_sync` (`lib.rs` L226+) — can affect DTR on some boards. |
| Capabilities | `src-tauri/capabilities/default.json`: `serialplugin:default`, `serialplugin:allow-available-ports`, plus `core:default`, `opener:default`, `store:default`. |
| Frontend shell | Single page `src/routes/+page.svelte`. Uses `listen` from `@tauri-apps/api/event` L4, L262+. Store: `@tauri-apps/plugin-store` in `settings.ts`, `webhook.ts`, `profiles.ts`, `bundled-presets.ts`. |
| Demo mode | `src/lib/demo.ts`: virtual ports `demo://<id>` (e.g. L160–170). Demo monitor started in `+page.svelte` `startDemoMonitor` L202+. Demo ports are **not** in Rust `MonitorRegistry`; `send_bytes_to_port` on demo returns “not being monitored”. |
| Tests / CI | Vitest 4 `vitest.config.ts` — `tests/**/*.test.ts`, `environment: 'node'`. Suites: `parser`, `profiles`, `agent-tools`, `webhook`, `cas-scale`. **No Svelte component tests.** Rust: M0 adds `#[cfg(test)]` in `lib.rs`. `.github/workflows/ci.yml`: `npm run check`, `npm test`, `npm run build`; `cargo fmt`, `clippy -D warnings`, `cargo check`, **`cargo test`** (M0). |
| CSP | `src-tauri/tauri.conf.json` L22–24: `"csp": null`. |

## Differences from PRD §2.1 text (not guesses)

| PRD claim | At HEAD |
|-----------|---------|
| No frontend import of serialplugin JS API | Still true: `rg serialplugin src` → **no matches**. |
| (Not listed in §2.1) | `package.json` **dependencies** include `tauri-plugin-serialplugin` ^2.17.1 — unused by `src/` imports; npm lock may pull it for tooling only. |
| `executeTool` passes context only | Confirmed — **`toolUseId` not wired** until M2.3. |
| Line numbers from `075b35e` | HEAD **is** `075b35e`; numbers above re-checked on working tree at M0. |

## M0.2 — `serialplugin` usage

**Command run:** `rg serialplugin src` → **no matches** (no TypeScript/Svelte use of the plugin JS API).

**Discovery and I/O:** Device listing uses the **`serialport`** crate only — `discovery.rs` L64 `serialport::available_ports()`. Port monitor, write channel, and baud probe use **`serialport`** in `lib.rs` (`buka_port_dengan_konfigurasi`, monitor thread). They do **not** call `tauri-plugin-serialplugin` APIs from Rust application code beyond plugin registration.

**`tauri_plugin_serialplugin::init()`** (`lib.rs` L374): plugin is loaded at startup. **M0 does not remove it** (per plan). Whether `init()` can be dropped entirely is a **M2.4** question (after narrowing capabilities); not proven at M0.

**`serialplugin:allow-available-ports`:** No frontend caller found. Likely redundant if listing stays on `serialport::available_ports()`; narrowing is **M2.4**, not M0.

**`serialplugin:default`:** Grants plugin default permissions including write/open paths the WebView does not use today. Safe Mode M2.4 should narrow based on this evidence.

## M0.3 — approved module layout

Same as [omnibridge-safe-mode-plan.md](./omnibridge-safe-mode-plan.md) § “Layout yang disetujui”:

- `src-tauri/src/safemode/mod.rs`
- `src-tauri/src/safemode/policy.rs`
- `src-tauri/src/safemode/rate_limit.rs`
- `src-tauri/src/safemode/approval.rs`
- `src-tauri/src/safemode/audit.rs`
- `src/lib/safemode.ts`
- `src/lib/ApprovalDialog.svelte`
- `src/lib/AuditLogPanel.svelte`

Policy path: `<app_config_dir>/safemode-policy.json`. Audit: `<app_data_dir>/safemode-audit.jsonl`. Safe Mode enabled state in Rust, default **on**.

## Manual regression checklist (use after M2 and M5)

Record pass/fail and date when run on real hardware where noted.

| Feature | M2 | M5 | Notes |
|---------|----|----|-------|
| Device discovery | | | |
| Start/stop port monitor | | | |
| RX `port:data` display | | | |
| Command Sender write | | | |
| Baud probe (port not monitored) | | | |
| Webhook forward | | | |
| Demo virtual port | | | |
| One-shot analysis | | | |
| Agent Investigate (pre–Safe Mode gate: direct write) | | | After M2: gated path only |

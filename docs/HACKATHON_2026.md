# Meta Global AI Developer Hackathon 2026

**Track:** Indie developer  
**Theme:** Push the Frontier  
**Built during the event (26 Oct – 4 Nov 2026):** the Muse Spark client, the **commit gate**, and the side-by-side demo. The Tauri shell, six investigation tools, and local regex parser already existed; they are context, not the submission.

## What is new

A confident, wrong protocol ID must not install a parser. `applyCommitGate` in `src/lib/commit-gate.ts` is code, not a prompt promise.

- **Naive lane** (`⬡ Analyze`): Muse Spark one-shot; parser installs without evidence (contrast).
- **Verified lane** (`🔬 Investigate`): tool loop on `muse-spark-1.3`; parser and device profile are stored only when framing evidence agrees (Modbus CRC ≥ 0.9, or ASCII field regexes matching the buffer).

Side-by-side page: `/hackathon`. Default stream is Modbus with CRC bytes flipped: naive still installs a parser; verified holds. Uncheck **Break CRC** to show a passing gate.

## Claim $150 Meta Model API credits (you must do this)

Credits cannot be claimed from this repo. Each accepted participant claims individually.

1. Open the Cerebral Valley [participant guide](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details).
2. Submit **Meta Global AI Hackathon: Model API Credit Claims**.
3. Credits arrive in batches. Add a payment card on the Model API **Billing** page (temporary pre-authorization). Set a **spend limit** at $150.
4. Create an API key at [dev.meta.ai](https://dev.meta.ai). Use **Standard** `muse-spark-1.3`, never `muse-spark-1.3-contributor`.
5. Paste the key in OmniBridge **Settings**. Click **Test connection**.

Deadline to claim: **4 Nov 2026, 9:00 PM ET**.

## Run the demo

```bash
cd OmniBridge
npm ci
npm test
npm run tauri dev
```

1. Settings → paste Meta Model API key → Test connection.
2. **Try Demo Mode** → open the CAS scale → **⬡ Analyze** (naive commit).
3. Open the Modbus PLC (or stay on CAS) → **🔬 Investigate** (verified gate).
4. Or open **Commit gate demo** (`/hackathon`) and **Run side-by-side**.

## Submission checklist

- Public GitHub repo.
- Three-minute video: only the commit gate (naive vs verified). Script: [HACKATHON_DEMO_SCRIPT.md](./HACKATHON_DEMO_SCRIPT.md). Done only when [HACKATHON_DOD.md](./HACKATHON_DOD.md) is all checked.
- Write-up of what was built **during** the hackathon (this file + CHANGELOG 0.3.0).
- Cerebral Valley submit by **4 Nov 2026, 9:00 PM ET** (5 Nov 09:00 WIB). Last troubleshooting day: 3 Nov.

## Built during the hackathon (file list)

- `src/lib/meta-api.ts` — Messages API client. SDK base `https://api.meta.ai` (path `/v1/messages`), bearer token, model `muse-spark-1.3`
- `src/lib/commit-gate.ts` — evidence gate
- `src/lib/commit-gate-demo.ts` — virtual CAS / Modbus buffers
- `src/routes/hackathon/+page.svelte` — side-by-side UI
- `tests/commit-gate.test.ts`
- Wiring in `claude.ts`, `settings.ts`, `profiles.ts`, `DataBuffer.svelte`, `SettingsModal.svelte`, `AnalysisPanel.svelte`

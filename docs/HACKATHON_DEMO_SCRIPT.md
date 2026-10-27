# 3-minute demo video — commit gate only

Judges must see **only** work from this hackathon. Do not tour webhooks, export, or the 2026 Claude Opus build. Caption on screen: *Built 26 Oct–4 Nov 2026 · muse-spark-1.3 · Indie · Push the Frontier*.

**Length:** 2:45–3:00. **Record by 2 Nov.** Submit 3 Nov.

## 0:00–0:25 — Stakes

Show unreadable serial bytes (demo Modbus or a terminal dump).

> A scale or PLC that talks undocumented bytes. The failure that keeps me up is not “unknown protocol.” It is a model that is confident, wrong, and about to send a command.

One sentence on screen: *Wrong parser + live machine.*

## 0:25–1:15 — Naive lane (same bytes)

Open `/hackathon` in the desktop window. Leave **Break CRC** on. The readout must already say **CRC 0.00**, need **0.90**. Press **Run both lanes**.

> Same stream, one-shot Muse Spark. The naive lane installs a parser with no evidence check. That is the unsafe default.

Hold on the sheet until Naive says **Installed**, with a confidence number and a field count. Do not linger on charts.

## 1:15–2:20 — Verified lane

Same sheet, same bytes. The Tools row must show `analyze_binary_structure`. Tool CRC must be a number below 0.90.

> The commit gate is code. The model can be sure. If the CRC is weak, fields stay empty and commands are withheld.

Leave **Held** on screen. That is the product. If Commands says `none returned` on the naive side, that take is not the one you submit — run again until the naive cell names a command and the verified cell says `withheld`.

## 2:20–2:40 — The gate can open

Uncheck **Break CRC**. Do not narrate a second feature. The readout moving from **0.00** to **1.00** is the proof this is a gate, not a permanent block.

## 2:40–3:00 — Close

> This is the work of this hackathon: Muse Spark on Meta Model API, plus a gate that will not let a parser touch a live stream until the bytes agree. Shell and tools were already here; the gate is new.

End card: repo URL, `/hackathon`, *Best Agentic Use-Case*.

## Do not show

Settings tour, webhook, CSV export, old Claude Opus README claims, medical/RAG anti-projects.

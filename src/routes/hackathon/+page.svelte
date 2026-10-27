<script lang="ts">
  import { onMount } from 'svelte';
  import {
    bufferModbusCrcRatio,
    buildDemoBufferLines,
    faceplateValuesVisible,
    readModbusMachine,
    shouldProveGateOpens,
  } from '$lib/commit-gate-demo.js';
  import { collectToolEvidence } from '$lib/commit-gate.js';
  import {
    analyzeStream,
    analyzeWithAgent,
    friendlyError,
    type AgentStep,
    type ProtocolAnalysis,
  } from '$lib/claude.js';
  import { META_MODEL_SPARK } from '$lib/meta-api.js';
  import type { DataLine } from '$lib/types.js';

  type ScenarioId = 'cas-scale' | 'modbus-plc';

  const NAMED_COMMAND_REQUIRED =
    'If you identify a protocol, include command_presets with at least one non-empty name. A failing CRC is not a reason to omit the name.';

  let scenario = $state<ScenarioId>('modbus-plc');
  let breakCrc = $state(true);
  let lines = $state<DataLine[]>([]);
  let naiveResult = $state<ProtocolAnalysis | null>(null);
  let verifiedResult = $state<ProtocolAnalysis | null>(null);
  let naiveError = $state<string | null>(null);
  let verifiedError = $state<string | null>(null);
  let agentTrace = $state<AgentStep[]>([]);
  let running = $state(false);
  let runGeneration = 0;

  function presetNames(result: ProtocolAnalysis | null): string[] {
    return (result?.command_presets ?? []).map((preset) => preset.name).filter(Boolean);
  }

  function replaceBuffer() {
    runGeneration += 1;
    running = false;
    lines = buildDemoBufferLines(scenario, scenario === 'modbus-plc' ? 30 : 20, {
      breakCrc: breakCrc && scenario === 'modbus-plc',
    });
    naiveResult = null;
    verifiedResult = null;
    naiveError = null;
    verifiedError = null;
    agentTrace = [];
  }

  function selectScenario(next: ScenarioId) {
    scenario = next;
    replaceBuffer();
  }

  function onBreakCrc(next: boolean) {
    const prove = shouldProveGateOpens({
      previousBreakCrc: breakCrc,
      nextBreakCrc: next,
      scenario,
      verifiedCommitted: verifiedResult?.committed,
      running,
    });
    breakCrc = next;
    replaceBuffer();
    if (prove) void runCompare();
  }

  function pushLiveFrame() {
    if (running || naiveResult || verifiedResult || lines.length === 0) return;
    const [next] = buildDemoBufferLines(scenario, 1, {
      breakCrc: breakCrc && scenario === 'modbus-plc',
    });
    if (!next) return;
    lines = [...lines.slice(1), { ...next, id: (lines[lines.length - 1]?.id ?? 0) + 1 }];
  }

  onMount(() => {
    replaceBuffer();
    const timer = setInterval(pushLiveFrame, 900);
    return () => clearInterval(timer);
  });

  async function runCompare() {
    if (lines.length === 0 || running) return;
    const generation = ++runGeneration;
    const sample = lines;
    running = true;
    naiveResult = null;
    verifiedResult = null;
    naiveError = null;
    verifiedError = null;
    agentTrace = [];

    const hex = sample.map((l) => l.hex);
    const ascii = sample.map((l) => l.ascii);

    const naivePromise = analyzeStream(hex, ascii, undefined, sample, NAMED_COMMAND_REQUIRED).then(
      (r) => {
        if (generation === runGeneration) naiveResult = r;
      },
      (e) => {
        if (generation === runGeneration) naiveError = friendlyError(e);
      }
    );

    const verifiedPromise = analyzeWithAgent(
      {
        port: `demo://${scenario}`,
        lines: sample,
        device: null,
        denyTransmit: true,
      },
      (step) => {
        if (generation !== runGeneration) return;
        agentTrace = [...agentTrace, step];
      }
    ).then((r) => {
      if (generation !== runGeneration) return;
      if (r.analysis) verifiedResult = r.analysis;
      if (r.error && !r.analysis) verifiedError = r.error;
    });

    await Promise.all([naivePromise, verifiedPromise]);
    if (generation === runGeneration) running = false;
  }

  const toolNames = $derived(
    agentTrace.filter((s) => s.type === 'tool_call').map((s) => s.tool_name ?? 'tool')
  );
  const bufferCrc = $derived(
    scenario === 'modbus-plc' ? bufferModbusCrcRatio(lines) : null
  );
  const toolCrc = $derived(collectToolEvidence(agentTrace).modbusValidityRatio);
  const crcWeak = $derived(bufferCrc !== null && bufferCrc.ratio < 0.9);
  const machine = $derived(
    scenario === 'modbus-plc' && lines.length > 0 ? readModbusMachine(lines[lines.length - 1].hex) : null
  );
  const valuesVisible = $derived(
    faceplateValuesVisible({
      verifiedCommitted: verifiedResult?.committed,
      crcRatio: bufferCrc?.ratio ?? null,
    })
  );
  const shownMachine = $derived(valuesVisible ? machine : null);

  function withheldNames(result: ProtocolAnalysis | null): string[] {
    return (result?.withheld_presets ?? [])
      .map((preset) => preset.name)
      .filter((name): name is string => Boolean(name));
  }
</script>

<svelte:head>
  <title>Commit gate</title>
</svelte:head>

<main class="page">
  <header class="mast">
    <div class="mast-top">
      <p class="kicker">26 Oct–4 Nov 2026 · {META_MODEL_SPARK} · Indie · Push the Frontier</p>
      <a class="back" href="/">Devices</a>
    </div>
    <h1>Do not install a parser the bytes cannot prove.</h1>
    <p class="lede">
      One buffer. Naive Muse Spark installs a parser. The gate withholds it when the frames disagree.
    </p>
  </header>

  <section class="bench" aria-label="Buffer evidence">
    <div class="readout">
      <span class="read-k">{bufferCrc ? 'CRC' : 'Check'}</span>
      <span class="read-n" class:weak={crcWeak}>
        {bufferCrc ? bufferCrc.ratio.toFixed(2) : 'regex'}
      </span>
      <span class="read-k">Need</span>
      <span class="read-n dim">{bufferCrc ? '0.90' : 'match'}</span>
      <span class="read-meta">
        {#if bufferCrc}
          {bufferCrc.valid}/{bufferCrc.frames} frames · {breakCrc ? 'CRC flipped' : 'frames intact'}
        {:else}
          {lines.length} ASCII lines
        {/if}
      </span>
    </div>
    {#if bufferCrc}
      <div class="rule" aria-hidden="true">
        <span class="rule-fill" class:weak={crcWeak} style:width="{Math.min(100, bufferCrc.ratio * 100)}%"></span>
        <span class="rule-mark"></span>
      </div>
    {/if}
    <div class="toolbar">
      <label>
        Stream
        <select
          value={scenario}
          onchange={(e) => selectScenario((e.currentTarget as HTMLSelectElement).value as ScenarioId)}
        >
          <option value="modbus-plc">Modbus RTU PLC</option>
          <option value="cas-scale">CAS weighing scale</option>
        </select>
      </label>
      <label class="check">
        <input
          type="checkbox"
          checked={breakCrc}
          disabled={scenario !== 'modbus-plc' || running}
          onchange={(e) => onBreakCrc((e.currentTarget as HTMLInputElement).checked)}
        />
        Break CRC
      </label>
      <button type="button" onclick={runCompare} disabled={running}>
        {running ? 'Muse Spark running…' : 'Run both lanes'}
      </button>
    </div>
    {#if scenario === 'modbus-plc'}
      <div class="machine" class:withheld={!shownMachine} aria-label="PLC faceplate">
        <span><b>Temp</b> {shownMachine ? `${shownMachine.temperatureC.toFixed(1)} °C` : '—'}</span>
        <span><b>Pressure</b> {shownMachine ? `${shownMachine.pressureHpa} hPa` : '—'}</span>
        <span><b>Flow</b> {shownMachine ? `${shownMachine.flowLMin} L/min` : '—'}</span>
        <span><b>Motor</b> {shownMachine ? `${shownMachine.motorRpm} rpm` : '—'}</span>
        <span><b>Valve</b> {shownMachine ? `${shownMachine.valvePercent}%` : '—'}</span>
        <span><b>Alarm</b> {shownMachine ? (shownMachine.alarm === 0 ? 'clear' : shownMachine.alarm) : '—'}</span>
      </div>
    {/if}
  </section>

  <section class="sheet" aria-label="Naive and verified on the same bytes">
    <div class="row head">
      <span></span>
      <span>Naive</span>
      <span>Verified</span>
    </div>
    <div class="row">
      <span class="lab">Decision</span>
      <span class="cell" class:warn={!!naiveResult && !naiveError} class:bad={!!naiveError}>
        {naiveError ? 'Error' : naiveResult ? 'Installed' : running ? 'Running' : '—'}
      </span>
      <span
        class="cell"
        class:bad={!!verifiedError && !verifiedResult}
        class:hold={verifiedResult?.committed === false}
        class:pass={!!verifiedResult && verifiedResult.committed !== false}
      >
        {#if verifiedError && !verifiedResult}
          Error
        {:else if verifiedResult?.committed === false}
          Held
        {:else if verifiedResult}
          Committed
        {:else if running}
          Running
        {:else}
          —
        {/if}
      </span>
    </div>
    <div class="row">
      <span class="lab">Confidence</span>
      <span class="cell num">{naiveResult ? `${naiveResult.confidence}%` : '—'}</span>
      <span class="cell num">{verifiedResult ? `${verifiedResult.confidence}%` : '—'}</span>
    </div>
    <div class="row">
      <span class="lab">Protocol</span>
      <span class="cell">{naiveResult?.protocol ?? '—'}</span>
      <span class="cell">{verifiedResult?.protocol ?? '—'}</span>
    </div>
    <div class="row">
      <span class="lab">Tool CRC</span>
      <span class="cell dim">not checked</span>
      <span class="cell num">{toolCrc === null ? '—' : toolCrc.toFixed(2)}</span>
    </div>
    <div class="row">
      <span class="lab">Fields</span>
      <span class="cell num">{naiveResult ? naiveResult.fields.length : '—'}</span>
      <span class="cell num">{verifiedResult ? verifiedResult.fields.length : '—'}</span>
    </div>
    <div class="row">
      <span class="lab">Commands</span>
      <span class="cell">
        {#if naiveResult && presetNames(naiveResult).length}
          {presetNames(naiveResult).join(', ')}
        {:else if naiveResult}
          none returned
        {:else}
          —
        {/if}
      </span>
      <span class="cell">
        {#if verifiedResult?.committed === false}
          {#if (verifiedResult.withheld_presets ?? []).length}
            withheld: {(verifiedResult.withheld_presets ?? []).map((preset) => preset.name).join(', ')}
          {:else}
            none proposed
          {/if}
        {:else if verifiedResult && presetNames(verifiedResult).length}
          {presetNames(verifiedResult).join(', ')}
        {:else if verifiedResult}
          none returned
        {:else}
          —
        {/if}
      </span>
    </div>
    <div class="row">
      <span class="lab">Tools</span>
      <span class="cell dim">one shot</span>
      <span class="cell">{toolNames.length ? toolNames.join(' → ') : '—'}</span>
    </div>
    <div class="row">
      <span class="lab">Why</span>
      <span class="cell why">{naiveError ?? naiveResult?.commit_reason ?? '—'}</span>
      <span class="cell why">{verifiedError && !verifiedResult ? verifiedError : verifiedResult?.commit_reason ?? '—'}</span>
    </div>
  </section>

  {#if !running && naiveResult && verifiedResult && (presetNames(naiveResult).length === 0 || (verifiedResult.committed === false && withheldNames(verifiedResult).length === 0))}
    <p class="retake">Retake this run. A saved take needs a naive command name and a withheld command name.</p>
  {/if}

  <div class="tape" aria-label="Buffer bytes">
    {#each lines as line (line.id)}
      <code class="frame">{scenario === 'modbus-plc' ? line.hex : line.ascii}</code>
    {:else}
      <code class="frame">—</code>
    {/each}
  </div>
</main>

<style>
  :global(html),
  :global(body) {
    height: 100%;
    margin: 0;
    background: #0d0d14;
    color-scheme: dark;
  }
  .page {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: 0.6rem 1rem 0.4rem;
    background: #0d0d14;
    color: #e4e4f0;
    font-family: ui-sans-serif, system-ui, sans-serif;
  }
  .mast {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding-bottom: 0.7rem;
    border-bottom: 1px solid #2a2a42;
  }
  .mast-top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
  }
  .kicker {
    margin: 0;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 0.68rem;
    letter-spacing: 0.01em;
    color: #7a8aa8;
  }
  h1 {
    margin: 0;
    font-size: clamp(1.45rem, 2.4vw, 1.85rem);
    line-height: 1.05;
    letter-spacing: -0.03em;
    font-weight: 650;
    color: #f2f2f8;
  }
  .lede {
    margin: 0;
    color: #8b93ad;
    font-size: 0.92rem;
    line-height: 1.35;
  }
  .back {
    color: #9aa8ff;
    font-size: 0.78rem;
    text-decoration: none;
    padding-bottom: 0.15rem;
  }
  .bench {
    margin-top: 0.4rem;
  }
  .readout {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.55rem 0.85rem;
  }
  .read-k {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 0.68rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #6d7590;
  }
  .read-n {
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 2.6rem;
    line-height: 0.9;
    letter-spacing: -0.05em;
    font-variant-numeric: tabular-nums;
    color: #86efac;
  }
  .read-n.weak {
    color: #fcd34d;
  }
  .read-n.dim {
    color: #9aa3bd;
    font-size: 1.35rem;
  }
  .read-meta {
    margin-left: auto;
    color: #7a8aa8;
    font-size: 0.82rem;
  }
  .rule {
    position: relative;
    height: 2px;
    margin: 0.4rem 0 0.45rem;
    background: #2a2a42;
  }
  .rule-fill {
    display: block;
    height: 100%;
    background: #86efac;
  }
  .rule-fill.weak {
    background: #fcd34d;
  }
  .rule-mark {
    position: absolute;
    top: -4px;
    left: 90%;
    width: 1px;
    height: 10px;
    background: #e4e4f0;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 0.85rem;
  }
  .machine {
    display: flex;
    flex-wrap: wrap;
    gap: 0.28rem 0.85rem;
    margin-top: 0.45rem;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 0.74rem;
    color: #d5dbea;
  }
  .machine b {
    font-weight: 500;
    color: #7f8ba8;
  }
  .machine.withheld {
    color: #6d7590;
  }
  .retake {
    margin: 0.55rem 0 0;
    color: #e0b15a;
    font-size: 0.78rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.68rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #6d7590;
  }
  label.check {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
    text-transform: none;
    letter-spacing: 0;
    font-size: 0.82rem;
    color: #c8cce0;
    padding-bottom: 0.35rem;
  }
  select,
  button {
    font: inherit;
    text-transform: none;
    letter-spacing: 0;
    color: #e4e4f0;
    background: #111120;
    border: 1px solid #2a2a42;
    border-radius: 2px;
    padding: 0.4rem 0.65rem;
    color-scheme: dark;
  }
  button {
    margin-left: auto;
    background: #4f6ef7;
    border-color: #4f6ef7;
    color: #fff;
    font-weight: 600;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .sheet {
    margin-top: 0.4rem;
    overflow: auto;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    padding: 0.05rem 0.7rem 0;
    border: 1px solid #2a2a42;
    background: #11111a;
  }
  .tape {
    flex: 1;
    min-height: 0;
    margin-top: 0.35rem;
    overflow: auto;
    display: grid;
    grid-template-columns: 1fr 1fr;
    align-content: start;
    gap: 0.28rem 0.6rem;
    font-size: 0.8rem;
    padding: 0.7rem 0.75rem;
    background: #09090f;
    border-left: 2px solid #2a2a42;
    color: #8e96b0;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    line-height: 1.45;
  }
  .frame {
    font-family: inherit;
    white-space: nowrap;
  }
  .row {
    flex: 0 0 auto;
    display: grid;
    grid-template-columns: 6.5rem minmax(0, 1fr) minmax(0, 1fr);
    gap: 0.75rem;
    padding: 0.14rem 0;
    border-bottom: 1px solid #1c1c2e;
    align-items: center;
  }
  .row.head {
    color: #9aa3bd;
    font-size: 0.72rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .lab {
    color: #6d7590;
    font-size: 0.75rem;
  }
  .cell {
    font-size: 0.92rem;
    min-width: 0;
  }
  .cell.num,
  .read-n {
    font-variant-numeric: tabular-nums;
  }
  .cell.num {
    font-family: "JetBrains Mono", ui-monospace, monospace;
  }
  .cell.dim {
    color: #5c647c;
  }
  .cell.why {
    color: #b7bdd0;
    font-size: 0.82rem;
    line-height: 1.4;
  }
  .cell.warn {
    color: #fcd34d;
  }
  .cell.hold,
  .cell.pass {
    color: #86efac;
  }
  .cell.bad {
    color: #fca5a5;
  }
  @media (max-width: 760px) {
    .mast-top {
      flex-direction: column;
      align-items: flex-start;
    }
    .read-meta,
    button {
      margin-left: 0;
    }
    .row {
      grid-template-columns: 4.5rem 1fr 1fr;
      gap: 0.45rem;
    }
  }
</style>

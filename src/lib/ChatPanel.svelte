<script lang="ts">
  import { fly } from 'svelte/transition';
  import { tick } from 'svelte';
  import { askAboutBuffer, friendlyError } from '$lib/claude.js';
  import type { DataLine } from '$lib/types.js';
  import type { ProtocolAnalysis } from '$lib/claude.js';

  export interface ChatMessage {
    id: number;
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
    error?: boolean;
  }

  let {
    history = $bindable([]),
    lines,
    analysis,
  }: {
    history: ChatMessage[];
    lines: DataLine[];
    analysis: ProtocolAnalysis | null;
  } = $props();

  let input = $state('');
  let sending = $state(false);
  let inputEl = $state<HTMLTextAreaElement | null>(null);
  let bodyEl = $state<HTMLDivElement | null>(null);
  let seqCounter = $state(0);

  async function scrollToBottom() {
    await tick();
    if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  const suggestedQuestions = [
    'What protocol is this?',
    'What was the highest value in the last minute?',
    'Are there any anomalies?',
    'How often are frames arriving?',
    'What do the fields mean?',
  ];

  async function send(question: string) {
    const q = question.trim();
    if (!q || sending) return;

    sending = true;
    input = '';

    const userMsg: ChatMessage = {
      id: ++seqCounter,
      role: 'user',
      content: q,
      timestamp: Date.now(),
    };
    const assistantMsg: ChatMessage = {
      id: ++seqCounter,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };
    history = [...history, userMsg, assistantMsg];
    scrollToBottom();

    try {
      await askAboutBuffer(
        {
          question: q,
          lines,
          analysis,
          history: history
            .slice(0, -2) // exclude the just-pushed user+empty-assistant pair
            .map((m) => ({ role: m.role, content: m.content })),
        },
        (chunk) => {
          assistantMsg.content += chunk;
          // Replace in the history array so Svelte reacts to the update
          history = history.map((m) => (m.id === assistantMsg.id ? assistantMsg : m));
          scrollToBottom();
        }
      );
    } catch (e) {
      assistantMsg.content = friendlyError(e);
      assistantMsg.error = true;
      history = history.map((m) => (m.id === assistantMsg.id ? assistantMsg : m));
    } finally {
      sending = false;
      await tick();
      inputEl?.focus();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  function clearHistory() {
    history = [];
  }

  function formatTime(ts: number): string {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
</script>

<div class="chat-panel">
  <div class="chat-header">
    <div class="header-left">
      <span class="header-icon">🤖</span>
      <span class="header-title">Ask Muse Spark about your data</span>
      {#if sending}
        <span class="thinking-chip">
          <span class="dot"></span>
          <span class="dot"></span>
          <span class="dot"></span>
        </span>
      {/if}
    </div>
    {#if history.length > 0}
      <button class="clear-btn" onclick={clearHistory} title="Clear conversation">
        Clear
      </button>
    {/if}
  </div>

  <div class="chat-body" bind:this={bodyEl}>
    {#if history.length === 0 && !sending}
      <div class="empty">
        <div class="empty-icon">💬</div>
        <div class="empty-title">Ask about the live stream</div>
        <div class="empty-sub">
          Muse Spark sees the recent buffer plus any protocol identification. Ask anything — values, trends, anomalies, structure.
        </div>
        <div class="suggestions">
          {#each suggestedQuestions as q}
            <button class="suggestion" onclick={() => send(q)} disabled={lines.length === 0}>
              {q}
            </button>
          {/each}
        </div>
        {#if lines.length === 0}
          <div class="hint">Start monitoring a device first.</div>
        {/if}
      </div>
    {:else}
      {#each history as msg (msg.id)}
        <div
          class="message"
          class:user={msg.role === 'user'}
          class:assistant={msg.role === 'assistant'}
          class:error={msg.error}
          in:fly={{ y: 8, duration: 180 }}
        >
          <div class="avatar">
            {msg.role === 'user' ? '👤' : msg.error ? '⚠' : '🤖'}
          </div>
          <div class="bubble">
            <div class="bubble-meta">
              <span class="bubble-role">{msg.role === 'user' ? 'You' : 'Muse Spark'}</span>
              <span class="bubble-time">{formatTime(msg.timestamp)}</span>
            </div>
            <div class="bubble-content">
              {#if msg.role === 'assistant' && msg.content === '' && sending}
                <span class="typing-cursor">▊</span>
              {:else}
                {msg.content}
                {#if msg.role === 'assistant' && sending && msg.id === history[history.length - 1]?.id}
                  <span class="typing-cursor">▊</span>
                {/if}
              {/if}
            </div>
          </div>
        </div>
      {/each}
    {/if}
  </div>

  <div class="chat-input-row">
    <textarea
      class="chat-input"
      placeholder={lines.length === 0 ? 'Start monitoring a device first…' : 'Ask anything — Enter to send, Shift+Enter for newline'}
      bind:value={input}
      bind:this={inputEl}
      onkeydown={handleKeydown}
      disabled={sending || lines.length === 0}
      rows="1"
    ></textarea>
    <button
      class="send-btn"
      onclick={() => send(input)}
      disabled={sending || !input.trim() || lines.length === 0}
      title="Send (Enter)"
    >
      {#if sending}
        ◌
      {:else}
        →
      {/if}
    </button>
  </div>
</div>

<style>
  .chat-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: #0a0e1a;
    overflow: hidden;
  }

  .chat-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.4rem 0.8rem;
    background: #0f1428;
    border-bottom: 1px solid #1e2a40;
    flex-shrink: 0;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .header-icon { font-size: 0.9rem; }

  .header-title {
    font-size: 0.72rem;
    font-weight: 600;
    color: #9090e0;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .thinking-chip {
    display: inline-flex;
    gap: 3px;
    margin-left: 0.3rem;
  }

  .thinking-chip .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #7090f0;
    animation: dotBounce 1.2s ease-in-out infinite;
  }
  .thinking-chip .dot:nth-child(2) { animation-delay: 0.15s; }
  .thinking-chip .dot:nth-child(3) { animation-delay: 0.3s; }

  @keyframes dotBounce {
    0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
    30% { opacity: 1; transform: translateY(-3px); }
  }

  .clear-btn {
    background: transparent;
    border: 1px solid #2a3450;
    color: #6a7a9a;
    font-size: 0.62rem;
    padding: 0.15rem 0.5rem;
    border-radius: 10px;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
  }

  .clear-btn:hover {
    background: #1a2038;
    color: #9aaad0;
    border-color: #3a4a70;
  }

  /* Body */
  .chat-body {
    flex: 1;
    overflow-y: auto;
    padding: 0.6rem 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    scrollbar-width: thin;
    scrollbar-color: #2a3450 transparent;
  }

  /* Empty state */
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 0.35rem;
    padding: 1.2rem;
    color: #4a5a7a;
  }

  .empty-icon {
    font-size: 2rem;
    opacity: 0.6;
  }

  .empty-title {
    font-size: 0.82rem;
    font-weight: 600;
    color: #8090c0;
  }

  .empty-sub {
    font-size: 0.72rem;
    color: #5a6a8a;
    line-height: 1.5;
    max-width: 340px;
  }

  .suggestions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    justify-content: center;
    margin-top: 0.4rem;
    max-width: 420px;
  }

  .suggestion {
    font-size: 0.7rem;
    background: #141c2e;
    color: #8090c0;
    border: 1px solid #1e2a40;
    padding: 0.3rem 0.6rem;
    border-radius: 14px;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
  }

  .suggestion:hover:not(:disabled) {
    background: #1e2a40;
    color: #b0c0e0;
    border-color: #2a3a5a;
  }

  .suggestion:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .hint {
    font-size: 0.65rem;
    color: #3a4a6a;
    font-style: italic;
    margin-top: 0.35rem;
  }

  /* Messages */
  .message {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
  }

  .avatar {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: #141c2e;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
  }

  .message.user .avatar {
    background: #1f2a50;
  }

  .message.assistant .avatar {
    background: #2a1e42;
  }

  .message.error .avatar {
    background: #2a1414;
  }

  .bubble {
    flex: 1;
    min-width: 0;
    background: #0f1828;
    border: 1px solid #1e2a40;
    border-radius: 6px;
    padding: 0.4rem 0.6rem;
  }

  .message.user .bubble {
    background: #121d36;
    border-color: #24305a;
  }

  .message.assistant .bubble {
    background: #151226;
    border-color: #2e2050;
  }

  .message.error .bubble {
    background: #1a0e0e;
    border-color: #3a1a1a;
  }

  .bubble-meta {
    display: flex;
    gap: 0.4rem;
    align-items: baseline;
    margin-bottom: 0.2rem;
  }

  .bubble-role {
    font-size: 0.62rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #8090c0;
  }

  .message.assistant .bubble-role { color: #a78bfa; }
  .message.error .bubble-role { color: #f87171; }

  .bubble-time {
    font-size: 0.6rem;
    color: #4a5a7a;
    font-family: "JetBrains Mono", monospace;
  }

  .bubble-content {
    font-size: 0.78rem;
    line-height: 1.55;
    color: #c0d0e8;
    white-space: pre-wrap;
    word-wrap: break-word;
  }

  .message.error .bubble-content { color: #fca5a5; }

  .typing-cursor {
    display: inline-block;
    color: #a78bfa;
    animation: cursorBlink 1s step-end infinite;
  }

  @keyframes cursorBlink {
    0%, 50% { opacity: 1; }
    51%, 100% { opacity: 0; }
  }

  /* Input */
  .chat-input-row {
    display: flex;
    gap: 0.4rem;
    padding: 0.45rem 0.6rem;
    background: #0f1428;
    border-top: 1px solid #1e2a40;
    align-items: flex-end;
    flex-shrink: 0;
  }

  .chat-input {
    flex: 1;
    background: #080c18;
    border: 1px solid #1e2a40;
    color: #c0d0e8;
    font-family: inherit;
    font-size: 0.78rem;
    padding: 0.4rem 0.55rem;
    border-radius: 5px;
    outline: none;
    resize: none;
    max-height: 100px;
    min-height: 28px;
    line-height: 1.4;
    transition: border-color 0.15s;
  }

  .chat-input:focus {
    border-color: #4f6ef7;
  }

  .chat-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .chat-input::placeholder {
    color: #3a4a6a;
  }

  .send-btn {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    background: #3a1e78;
    color: #fff;
    border: 1px solid #5a3ab0;
    border-radius: 5px;
    cursor: pointer;
    font-size: 0.95rem;
    transition: all 0.15s;
  }

  .send-btn:hover:not(:disabled) {
    background: #4a2e92;
    border-color: #7050d0;
  }

  .send-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }
</style>

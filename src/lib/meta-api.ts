import Anthropic from '@anthropic-ai/sdk';

/** SDK base URL. The Anthropic client appends `/v1/messages`. */
export const META_MODEL_API_BASE = 'https://api.meta.ai';

/** Class only. Never log the key itself. */
export function metaKeyClass(key: string | null | undefined): 'empty' | 'meta' | 'anthropic' | 'other' {
  const trimmed = key?.trim() ?? '';
  if (!trimmed) return 'empty';
  if (trimmed.startsWith('LLM_')) return 'meta';
  if (trimmed.startsWith('sk-ant')) return 'anthropic';
  return 'other';
}

/** Meta Model API accepts Standard keys that start with LLM_. */
export function usableMetaKey(key: string | null | undefined): string | null {
  const trimmed = key?.trim() ?? '';
  return trimmed.startsWith('LLM_') ? trimmed : null;
}
export const META_MODEL_SPARK = 'muse-spark-1.3';

/** Muse Spark Standard list pricing (USD per 1M tokens) — for UI estimates only. */
export const MUSE_SPARK_PRICING_USD_PER_MTOK = {
  input: 1.25,
  output: 4.25,
  cache_read: 0.15,
  cache_write: 1.25,
};

let _client: Anthropic | null = null;
let _clientKey = '';

export function createMetaModelClient(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey: null,
    authToken: apiKey,
    baseURL: META_MODEL_API_BASE,
    dangerouslyAllowBrowser: true,
  });
}

export function getMetaModelClient(apiKey: string): Anthropic {
  if (!_client || _clientKey !== apiKey) {
    _client = createMetaModelClient(apiKey);
    _clientKey = apiKey;
  }
  return _client;
}

export function resetMetaModelClient(): void {
  _client = null;
  _clientKey = '';
}

import { Store } from '@tauri-apps/plugin-store';
import { invoke } from '@tauri-apps/api/core';

const STORE_FILE = 'omnibridge.webhooks.json';
const KEY_CONFIGS = 'configs';

export type WebhookMethod = 'POST' | 'PUT' | 'PATCH';

/** How the request body is encoded.
 *  - `json`: structured WebhookPayload as application/json (default).
 *  - `form`: render `form_template` into application/x-www-form-urlencoded.
 *    Needed for legacy endpoints that read `$_POST` form fields (e.g. a
 *    CodeIgniter `$this->input->post('scales-weight')` controller). */
export type WebhookBodyFormat = 'json' | 'form';

export interface WebhookConfig {
  enabled: boolean;
  url: string;
  method: WebhookMethod;
  throttle_ms: number;
  include_raw: boolean;
  custom_headers: string; // newline-separated "Key: Value"
  body_format: WebhookBodyFormat;
  form_template: string; // e.g. "scales-code={{scales_code}}&scales-weight={{weight}}&company-id={{company_id}}"
  /** Kode timbangan untuk endpoint legacy (dropdown). */
  scales_code: string;
  /** ID perusahaan untuk endpoint legacy (dropdown). */
  company_id: string;
  /** Centang ENTIS = auto-forward webhook aktif; juga dikirim sebagai entis=1/0 di form body. */
  entis: boolean;
}

export interface WebhookStats {
  sent: number;
  failed: number;
  last_status: string | null;
  last_sent_at: number | null;
  last_error: string | null;
}

export interface WebhookPayload {
  timestamp: number;
  port: string;
  device_class?: string;
  protocol: string;
  confidence: number;
  fields: Record<
    string,
    { value: string | number | boolean; unit?: string; updated_at: number }
  >;
  raw_line?: { ascii: string; hex: string; timestamp: number };
}

export function defaultConfig(): WebhookConfig {
  return {
    enabled: false,
    url: '',
    method: 'POST',
    throttle_ms: 1000,
    include_raw: false,
    custom_headers: '',
    body_format: 'json',
    form_template: '',
    scales_code: 'S100',
    company_id: '2',
    entis: false,
  };
}

/** Template form standar untuk integrasi timbangan legacy. */
export function templateFormTimbangan(): string {
  return 'scales-code={{scales_code}}&scales-weight={{weight}}&company-id={{company_id}}&entis={{entis}}';
}

export function defaultStats(): WebhookStats {
  return {
    sent: 0,
    failed: 0,
    last_status: null,
    last_sent_at: null,
    last_error: null,
  };
}

let _store: Store | null = null;
async function getStore(): Promise<Store> {
  if (!_store) _store = await Store.load(STORE_FILE);
  return _store;
}

async function getAllConfigs(): Promise<Record<string, WebhookConfig>> {
  try {
    const store = await getStore();
    return (await store.get<Record<string, WebhookConfig>>(KEY_CONFIGS)) ?? {};
  } catch {
    return {};
  }
}

export async function getConfig(fingerprint: string): Promise<WebhookConfig | null> {
  const all = await getAllConfigs();
  const stored = all[fingerprint];
  if (!stored) return null;
  // Merge defaults so configs saved before body_format/form_template existed
  // still load with sane values instead of undefined.
  const merged = { ...defaultConfig(), ...stored };
  // ENTIS = saklar auto-forward; selaraskan dengan enabled
  if (stored.entis === undefined && stored.enabled) {
    merged.entis = true;
  }
  merged.enabled = merged.entis;
  return merged;
}

export async function saveConfig(fingerprint: string, config: WebhookConfig): Promise<void> {
  const store = await getStore();
  const all = await getAllConfigs();
  all[fingerprint] = config;
  await store.set(KEY_CONFIGS, all);
  await store.save();
}

export async function deleteConfig(fingerprint: string): Promise<void> {
  const store = await getStore();
  const all = await getAllConfigs();
  delete all[fingerprint];
  await store.set(KEY_CONFIGS, all);
  await store.save();
}

export function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 0) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
}

export interface SendResult {
  ok: boolean;
  status: number | null;
  error?: string;
  bodyPreview?: string;
}

/** Resolve a single `{{token}}` against the payload. Field values win over the
 *  top-level metadata keys, so `{{weight}}` pulls fields.weight.value. */
function resolveToken(
  token: string,
  payload: WebhookPayload,
  config?: WebhookConfig
): string {
  switch (token) {
    case 'port':
      return payload.port;
    case 'protocol':
      return payload.protocol;
    case 'confidence':
      return String(payload.confidence);
    case 'timestamp':
      return String(payload.timestamp);
    case 'device_class':
      return payload.device_class ?? '';
    case 'scales_code':
      return config?.scales_code ?? '';
    case 'company_id':
      return config?.company_id ?? '';
    case 'entis':
      return config?.entis ? '1' : '0';
    default: {
      const field = payload.fields[token];
      return field ? String(field.value) : '';
    }
  }
}

/** Render a form template like `scales-weight={{weight}}&company-id=1` into a
 *  urlencoded body. Only the substituted VALUES are encoded — the `&`/`=`
 *  structure is left literal so it stays a valid form body. */
export function renderFormBody(
  template: string,
  payload: WebhookPayload,
  config?: WebhookConfig
): string {
  return template.replace(/\{\{\s*([\w._-]+)\s*\}\}/g, (_match, token: string) =>
    encodeURIComponent(resolveToken(token, payload, config))
  );
}

interface TauriWebhookResponse {
  ok: boolean;
  status: number;
  body_preview: string;
}

export async function sendWebhook(
  config: WebhookConfig,
  payload: WebhookPayload
): Promise<SendResult> {
  if (!config.url) return { ok: false, status: null, error: 'URL is empty' };

  try {
    const url = new URL(config.url);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { ok: false, status: null, error: 'URL must be http:// or https://' };
    }
  } catch {
    return { ok: false, status: null, error: 'Invalid URL format' };
  }

  let body: string;
  let contentType: string;
  if (config.body_format === 'form') {
    const template =
      config.form_template?.trim() || templateFormTimbangan();
    body = renderFormBody(template, payload, config);
    contentType = 'application/x-www-form-urlencoded';
  } else {
    body = JSON.stringify(payload);
    contentType = 'application/json';
  }

  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'User-Agent': 'OmniBridge/0.1',
    ...parseHeaders(config.custom_headers),
  };

  // Send via the Rust side (native HTTP client) so the request bypasses the
  // WebView's CORS enforcement. A browser fetch() to a legacy endpoint without
  // Access-Control-* headers fails preflight as "TypeError: Failed to fetch".
  try {
    const res = await invoke<TauriWebhookResponse>('send_webhook_request', {
      url: config.url,
      method: config.method,
      headers,
      body,
    });

    return {
      ok: res.ok,
      status: res.status,
      bodyPreview: res.body_preview,
      error: res.ok ? undefined : `HTTP ${res.status}`,
    };
  } catch (e) {
    return { ok: false, status: null, error: String(e) };
  }
}

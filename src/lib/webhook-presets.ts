import {
  defaultSendFilter,
  type WebhookBodyFormat,
  type WebhookConfig,
  type WebhookMethod,
  type WebhookSendFilter,
} from './webhook.js';

/** Bagian konfigurasi webhook yang diisi oleh preset — URL dan header
 *  sengaja tidak disentuh agar API key user tetap aman. */
export interface WebhookPresetPatch {
  method?: WebhookMethod;
  body_format?: WebhookBodyFormat;
  form_template?: string;
  send_filter?: WebhookSendFilter;
}

export interface WebhookPreset {
  id: string;
  label: string;
  description: string;
  patch: WebhookPresetPatch;
}

export const WEBHOOK_PRESETS: WebhookPreset[] = [
  {
    id: 'json-default',
    label: 'JSON — Zapier / n8n',
    description: 'Structured JSON payload (default)',
    patch: {
      method: 'POST',
      body_format: 'json',
      form_template: '',
      send_filter: defaultSendFilter(),
    },
  },
  {
    id: 'form-legacy',
    label: 'Form — Legacy $_POST API',
    description: 'URL-encoded form fields for PHP/CodeIgniter endpoints',
    patch: {
      method: 'POST',
      body_format: 'form',
      form_template: 'device-id={{port}}&reading={{weight}}&timestamp={{timestamp}}',
      send_filter: defaultSendFilter(),
    },
  },
  {
    id: 'form-scale',
    label: 'Form — Industrial Scale',
    description: 'Scale field mapping; sends only when stable=ST',
    patch: {
      method: 'POST',
      body_format: 'form',
      form_template: 'device-code={{port}}&weight={{weight}}&stable={{stable}}',
      send_filter: { enabled: true, field: 'stable', value: 'ST' },
    },
  },
  {
    id: 'json-homeassistant',
    label: 'JSON — Home Assistant',
    description: 'Structured JSON for HA webhook triggers',
    patch: {
      method: 'POST',
      body_format: 'json',
      form_template: '',
      send_filter: defaultSendFilter(),
    },
  },
];

/** Terapkan preset ke draft config tanpa menimpa URL atau custom headers. */
export function applyWebhookPreset(
  config: WebhookConfig,
  preset: WebhookPreset
): WebhookConfig {
  return {
    ...config,
    ...preset.patch,
    send_filter: preset.patch.send_filter ?? defaultSendFilter(),
  };
}

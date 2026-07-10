import type { WebhookConfig } from './webhook.js';

/** URL staging ENTIS — dipakai otomatis saat mode DEV. */
export const URL_WEBHOOK_DEV = 'https://dev.bat.entis.app/api/scale';

/** URL production ENTIS — dipakai otomatis saat mode ONLINE. */
export const URL_WEBHOOK_ONLINE = 'https://bat.entis.app/api/scale';

/** gs-key ENTIS untuk header webhook. */
export const NILAI_GS_KEY = '8g0kc4skc0gc40kkgcskw40kgg0k84ssgcs4ss4w';

/** Header siap pakai di modal webhook. */
export const HEADER_CUSTOM_DEFAULT = `gs-key: ${NILAI_GS_KEY}`;

/**
 * Kunci API Anthropic — di-inline ke bundle saat build jika
 * VITE_ANTHROPIC_API_KEY diset (lokal .env atau secret CI).
 */
export const KUNCI_API_ANTHROPIC_DEFAULT =
  (import.meta.env.VITE_ANTHROPIC_API_KEY as string) || '';

/** Konfigurasi webhook CAS bawaan — dipakai preset, defaultConfig, dan merge store. */
export function konfigurasiWebhookCasDefault(): WebhookConfig {
  return {
    enabled: false,
    url: URL_WEBHOOK_DEV,
    method: 'POST',
    throttle_ms: 1000,
    include_raw: false,
    custom_headers: HEADER_CUSTOM_DEFAULT,
    body_format: 'form',
    form_template:
      'scales-code={{scales_code}}&scales-weight={{weight}}&company-id={{company_id}}&entis={{entis}}',
    scales_code: 'S100',
    company_id: '2',
    entis: false,
    mode_webhook: 'DEV',
  };
}

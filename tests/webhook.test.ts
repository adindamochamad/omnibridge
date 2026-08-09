import { describe, it, expect } from 'vitest';
import {
  parseHeaders,
  defaultConfig,
  sendWebhook,
  renderFormBody,
  shouldSendWebhook,
  type WebhookPayload,
} from '../src/lib/webhook.js';
import { urlEfektifUntukWebhook, URL_WEBHOOK_ONLINE } from '../src/lib/cas-scale.js';
import { URL_WEBHOOK_DEV } from '../src/lib/konfigurasi-default-cas.js';
import { applyWebhookPreset, WEBHOOK_PRESETS } from '../src/lib/webhook-presets.js';

const samplePayload: WebhookPayload = {
  timestamp: 1719500000000,
  port: 'SCALE-01',
  device_class: 'scale',
  protocol: 'CAS Scale',
  confidence: 0.95,
  fields: {
    weight: { value: 1.234, unit: 'kg', updated_at: 1719500000000 },
    stable: { value: 'ST', updated_at: 1719500000000 },
  },
};

const unstablePayload: WebhookPayload = {
  ...samplePayload,
  fields: {
    ...samplePayload.fields,
    stable: { value: 'US', updated_at: 1719500000000 },
  },
};

describe('urlEfektifUntukWebhook', () => {
  it('DEV fallback ke URL staging jika url kosong', () => {
    expect(urlEfektifUntukWebhook({ mode_webhook: 'DEV', url: '' })).toBe(URL_WEBHOOK_DEV);
  });

  it('ONLINE selalu ke bat.entis.app', () => {
    expect(
      urlEfektifUntukWebhook({ mode_webhook: 'ONLINE', url: 'https://dev.bat.entis.app/api/scale' })
    ).toBe(URL_WEBHOOK_ONLINE);
  });
});

describe('parseHeaders', () => {
  it('parses simple Key: Value pairs', () => {
    const h = parseHeaders('X-Auth: secret\nContent-Type: application/json');
    expect(h).toEqual({ 'X-Auth': 'secret', 'Content-Type': 'application/json' });
  });

  it('skips blank lines and # comments', () => {
    const h = parseHeaders('# this is a comment\n\nX-Real: yes\n# another comment');
    expect(h).toEqual({ 'X-Real': 'yes' });
  });

  it('handles values that contain colons', () => {
    const h = parseHeaders('Authorization: Bearer abc:def:ghi');
    expect(h.Authorization).toBe('Bearer abc:def:ghi');
  });

  it('ignores malformed lines without colon', () => {
    const h = parseHeaders('not_a_header_line\nX-OK: good');
    expect(h).toEqual({ 'X-OK': 'good' });
  });

  it('trims whitespace around key and value', () => {
    const h = parseHeaders('  X-Spaced  :   trimmed value  ');
    expect(h).toEqual({ 'X-Spaced': 'trimmed value' });
  });
});

describe('renderFormBody', () => {
  const cfg = { ...defaultConfig(), scales_code: 'S100', company_id: '2', entis: true };

  it('substitutes field tokens and url-encodes values', () => {
    const body = renderFormBody(
      'scales-code={{scales_code}}&scales-weight={{weight}}&company-id={{company_id}}&entis={{entis}}',
      samplePayload,
      cfg
    );
    expect(body).toBe('scales-code=S100&scales-weight=1.234&company-id=2&entis=1');
  });

  it('resolves entis=0 when checkbox off', () => {
    const body = renderFormBody('entis={{entis}}', samplePayload, { ...cfg, entis: false });
    expect(body).toBe('entis=0');
  });

  it('resolves top-level metadata tokens', () => {
    const body = renderFormBody('protocol={{protocol}}&conf={{confidence}}', samplePayload, cfg);
    expect(body).toBe('protocol=CAS%20Scale&conf=0.95');
  });

  it('leaves unknown tokens empty', () => {
    const body = renderFormBody('missing={{unknown}}', samplePayload, cfg);
    expect(body).toBe('missing=');
  });

  it('supports legacy port token for backward compatibility', () => {
    const body = renderFormBody(
      'scales-code={{port}}&scales-weight={{weight}}&company-id=1',
      samplePayload,
      cfg
    );
    expect(body).toBe('scales-code=SCALE-01&scales-weight=1.234&company-id=1');
  });
});

describe('shouldSendWebhook', () => {
  it('allows all payloads when filter is disabled', () => {
    const cfg = { ...defaultConfig(), send_filter: { enabled: false, field: '', value: '' } };
    expect(shouldSendWebhook(cfg, samplePayload)).toBe(true);
    expect(shouldSendWebhook(cfg, unstablePayload)).toBe(true);
  });

  it('blocks payload when field value does not match', () => {
    const cfg = {
      ...defaultConfig(),
      send_filter: { enabled: true, field: 'stable', value: 'ST' },
    };
    expect(shouldSendWebhook(cfg, samplePayload)).toBe(true);
    expect(shouldSendWebhook(cfg, unstablePayload)).toBe(false);
  });

  it('blocks when filter field is missing from payload', () => {
    const cfg = {
      ...defaultConfig(),
      send_filter: { enabled: true, field: 'missing', value: 'x' },
    };
    expect(shouldSendWebhook(cfg, samplePayload)).toBe(false);
  });

  it('passes through when filter enabled but field name empty', () => {
    const cfg = {
      ...defaultConfig(),
      send_filter: { enabled: true, field: '', value: 'ST' },
    };
    expect(shouldSendWebhook(cfg, unstablePayload)).toBe(true);
  });
});

describe('webhook presets', () => {
  it('applies preset without overwriting URL or headers', () => {
    const cfg = {
      ...defaultConfig(),
      url: 'https://example.com/hook',
      custom_headers: 'X-API-Key: secret',
    };
    const preset = WEBHOOK_PRESETS.find((p) => p.id === 'form-scale')!;
    const hasil = applyWebhookPreset(cfg, preset);
    expect(hasil.url).toBe('https://example.com/hook');
    expect(hasil.custom_headers).toBe('X-API-Key: secret');
    expect(hasil.body_format).toBe('form');
    expect(hasil.send_filter.enabled).toBe(true);
    expect(hasil.send_filter.field).toBe('stable');
  });
});

describe('sendWebhook URL validation', () => {
  it('default config punya URL DEV dan gs-key placeholder', () => {
    const cfg = defaultConfig();
    expect(cfg.url).toBe(URL_WEBHOOK_DEV);
    expect(cfg.custom_headers).toContain('gs-key');
  });

  it('rejects non-http(s) protocol', async () => {
    const cfg = { ...defaultConfig(), url: 'file:///etc/passwd', enabled: true };
    const res = await sendWebhook(cfg, {
      timestamp: Date.now(),
      port: 'test',
      protocol: 'test',
      confidence: 0,
      fields: {},
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/http/i);
  });

  it('rejects malformed URL', async () => {
    const cfg = { ...defaultConfig(), url: 'not a url', enabled: true };
    const res = await sendWebhook(cfg, {
      timestamp: Date.now(),
      port: 'test',
      protocol: 'test',
      confidence: 0,
      fields: {},
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/url/i);
  });
});

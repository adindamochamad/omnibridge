import { describe, it, expect } from 'vitest';
import {
  parseHeaders,
  defaultConfig,
  sendWebhook,
  renderFormBody,
  type WebhookPayload,
} from '../src/lib/webhook.js';

const samplePayload: WebhookPayload = {
  timestamp: 1719500000000,
  port: 'TIMBANGAN-01',
  device_class: 'scale',
  protocol: 'CAS Scale',
  confidence: 0.95,
  fields: {
    weight: { value: 1.234, unit: 'kg', updated_at: 1719500000000 },
    stable: { value: 'ST', updated_at: 1719500000000 },
  },
};

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
    const body = renderFormBody(
      'entis={{entis}}',
      samplePayload,
      { ...cfg, entis: false }
    );
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
    expect(body).toBe('scales-code=TIMBANGAN-01&scales-weight=1.234&company-id=1');
  });
});

describe('sendWebhook URL validation', () => {
  it('rejects empty URL', async () => {
    const res = await sendWebhook(defaultConfig(), {
      timestamp: Date.now(),
      port: 'test',
      protocol: 'test',
      confidence: 0,
      fields: {},
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/empty/i);
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

import { describe, expect, it } from 'vitest';
import {
  createMetaModelClient,
  META_MODEL_API_BASE,
  META_MODEL_SPARK,
  metaKeyClass,
  usableMetaKey,
} from '../src/lib/meta-api.js';

describe('Meta Model API constants', () => {
  it('points the Anthropic SDK at muse-spark-1.3 with a bearer token', () => {
    expect(META_MODEL_API_BASE).toBe('https://api.meta.ai');
    expect(META_MODEL_SPARK).toBe('muse-spark-1.3');
    expect(META_MODEL_SPARK).not.toContain('contributor');

    const client = createMetaModelClient('LLM_test_key');
    expect(client.baseURL).toBe('https://api.meta.ai');
    expect(client.authToken).toBe('LLM_test_key');
    expect(client.apiKey).toBeNull();
  });

  it('refuses an Anthropic key and accepts a Meta Standard key', () => {
    expect(metaKeyClass('sk-ant-example')).toBe('anthropic');
    expect(usableMetaKey('sk-ant-example')).toBeNull();
    expect(metaKeyClass('LLM_example_key')).toBe('meta');
    expect(usableMetaKey('  LLM_example_key  ')).toBe('LLM_example_key');
    expect(usableMetaKey('')).toBeNull();
  });
});

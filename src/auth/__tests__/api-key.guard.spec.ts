import Fastify from 'fastify';
import { describe, it, expect } from 'vitest';
import { createApiKeyGuard, findMatchingKey } from '../api-key.guard.js';

describe('findMatchingKey', () => {
  const keys = [
    { key: 'test-key-1', label: 'production' },
    { key: 'test-key-2', label: 'staging' },
  ];

  it('returns matching key config for valid key', () => {
    const result = findMatchingKey('test-key-1', keys);
    expect(result).toEqual({ key: 'test-key-1', label: 'production' });
  });

  it('returns second key when matching', () => {
    const result = findMatchingKey('test-key-2', keys);
    expect(result).toEqual({ key: 'test-key-2', label: 'staging' });
  });

  it('returns undefined for invalid key', () => {
    const result = findMatchingKey('wrong-key', keys);
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    const result = findMatchingKey('', keys);
    expect(result).toBeUndefined();
  });

  it('does not match partial keys', () => {
    const result = findMatchingKey('test-key', keys);
    expect(result).toBeUndefined();
  });
});

describe('createApiKeyGuard', () => {
  it('skips authentication for health checks with query parameters', async () => {
    const app = Fastify();
    app.addHook('onRequest', createApiKeyGuard({ apiKeys: [{ key: 'test-key', label: 'test' }] }));
    app.get('/health', () => ({ status: 'ok' }));

    const response = await app.inject({ method: 'GET', url: '/health?cachebust=1' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('returns 401 for a same-code-unit-length key with a different UTF-8 byte length', async () => {
    const app = Fastify();
    const configuredKey = `kc_${'a'.repeat(48)}`;
    const nonAsciiKey = `kc_é${'a'.repeat(47)}`;
    app.addHook(
      'onRequest',
      createApiKeyGuard({ apiKeys: [{ key: configuredKey, label: 'test' }] }),
    );
    app.get('/protected', () => ({ status: 'ok' }));

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { 'x-api-key': nonAsciiKey },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Invalid API key' });
    await app.close();
  });
});

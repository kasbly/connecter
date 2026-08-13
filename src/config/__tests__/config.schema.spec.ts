import { describe, expect, it } from 'vitest';
import { connectorConfigSchema } from '../config.schema.js';

function createConfigInput(databaseOverrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    auth: {
      apiKeys: [{ key: 'test-key', label: 'test' }],
    },
    database: {
      type: 'postgres',
      host: 'database.internal',
      database: 'inventory',
      user: 'connector',
      password: 'password',
      ...databaseOverrides,
    },
    resources: {
      inventory: {
        table: 'cars',
        idColumn: 'id',
        fields: { externalId: 'id' },
      },
    },
  };
}

describe('connectorConfigSchema database TLS options', () => {
  it('defaults certificate verification to enabled', () => {
    const config = connectorConfigSchema.parse(createConfigInput({ ssl: true }));

    expect(config.database.sslRejectUnauthorized).toBe(true);
    expect(config.database.sslCa).toBeUndefined();
  });

  it('accepts a pinned CA bundle and an explicit verification escape hatch', () => {
    const sslCa = '-----BEGIN CERTIFICATE-----\nprivate-ca\n-----END CERTIFICATE-----';
    const config = connectorConfigSchema.parse(
      createConfigInput({
        ssl: true,
        sslCa,
        sslRejectUnauthorized: false,
      }),
    );

    expect(config.database).toMatchObject({
      ssl: true,
      sslCa,
      sslRejectUnauthorized: false,
    });
  });

  it('rejects an empty CA bundle', () => {
    expect(() =>
      connectorConfigSchema.parse(createConfigInput({ ssl: true, sslCa: '' })),
    ).toThrow();
  });
});

describe('connectorConfigSchema database statement timeout', () => {
  it('defaults queries to a bounded ten-second timeout', () => {
    const config = connectorConfigSchema.parse(createConfigInput());

    expect(config.database.statementTimeoutMs).toBe(10_000);
  });

  it('accepts a configured timeout within the safety bounds', () => {
    const config = connectorConfigSchema.parse(createConfigInput({ statementTimeoutMs: 2_500 }));

    expect(config.database.statementTimeoutMs).toBe(2_500);
  });

  it.each([0, 99, 120_001])('rejects an unsafe timeout of %dms', (statementTimeoutMs) => {
    expect(() => connectorConfigSchema.parse(createConfigInput({ statementTimeoutMs }))).toThrow();
  });
});

describe('connectorConfigSchema audit file size', () => {
  it('rejects audit rotation thresholds above the safety cap', () => {
    expect(() =>
      connectorConfigSchema.parse({ ...createConfigInput(), audit: { maxFileSizeMB: 501 } }),
    ).toThrow();
  });
});

// Issue #15729 — trustedProxies gates whether forwarded headers (X-Forwarded-For,
// X-Real-IP) are honored for rate-limiting and audit-log IP attribution.
describe('connectorConfigSchema server.trustedProxies', () => {
  it('defaults to unset (forwarded headers are never trusted)', () => {
    const config = connectorConfigSchema.parse(createConfigInput());

    expect(config.server.trustedProxies).toBeUndefined();
  });

  it('accepts a comma-separated IP/CIDR allowlist', () => {
    const config = connectorConfigSchema.parse({
      ...createConfigInput(),
      server: { trustedProxies: '10.0.0.0/8,203.0.113.5' },
    });

    expect(config.server.trustedProxies).toBe('10.0.0.0/8,203.0.113.5');
  });

  it('rejects an empty trustedProxies string', () => {
    expect(() =>
      connectorConfigSchema.parse({
        ...createConfigInput(),
        server: { trustedProxies: '' },
      }),
    ).toThrow();
  });
});

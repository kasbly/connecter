import { describe, expect, it } from 'vitest';
import { parse } from 'dotenv';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  quoteIfNeeded,
  serializeEnvValue,
  shouldDefaultToTls,
  writePrivateFile,
} from '../wizard.js';

describe('quoteIfNeeded', () => {
  it.each(['desc', 'order', 'user', 'limit', 'group'])(
    'quotes the PostgreSQL reserved word %s',
    (identifier) => {
      expect(quoteIfNeeded(identifier)).toBe(`"${identifier}"`);
    },
  );

  it('quotes ordinary identifiers and escapes embedded quotes', () => {
    expect(quoteIfNeeded('inventory_id')).toBe('"inventory_id"');
    expect(quoteIfNeeded('merchant"sku')).toBe('"merchant""sku"');
  });
});

describe('shouldDefaultToTls', () => {
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '::1'])(
    'does not default to TLS for %s',
    (host) => {
      expect(shouldDefaultToTls(host)).toBe(false);
    },
  );

  it('defaults to TLS for a remote database host', () => {
    expect(shouldDefaultToTls('postgres.example.com')).toBe(true);
  });
});

describe('writePrivateFile', () => {
  it('creates and repairs generated files with owner-only permissions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kasbly-connector-wizard-'));
    const path = join(directory, '.env');
    try {
      writeFileSync(path, 'old', { mode: 0o644 });
      writePrivateFile(path, 'DB_PASSWORD=secret\n');
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('serializeEnvValue', () => {
  it.each(['p@ss#word', 'my pass ', 'a"b#c', "a'b#c"])(
    'round-trips dotenv-significant value %j',
    (value) => {
      expect(parse(`DB_PASSWORD=${serializeEnvValue(value)}\n`).DB_PASSWORD).toBe(value);
    },
  );
});

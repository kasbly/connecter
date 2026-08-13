import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quoteIfNeeded, writePrivateFile } from '../wizard.js';

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

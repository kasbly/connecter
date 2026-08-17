import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { AuditService, type AuditEntry } from '../audit.service.js';

const TEST_DIR = join(process.cwd(), '.test-audit-logs');
const TEST_FILE = join(TEST_DIR, 'test-audit.log');

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: new Date().toISOString(),
    method: 'GET',
    path: '/inventory',
    query: {},
    apiKey: 'test',
    status: 200,
    items: 10,
    ms: 45,
    ip: '127.0.0.1',
    ...overrides,
  };
}

describe('AuditService', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  it('creates log directory if it does not exist', () => {
    new AuditService({
      enabled: true,
      filePath: TEST_FILE,
      maxFileSizeMB: 50,
      retentionDays: 90,
    });
    expect(existsSync(TEST_DIR)).toBe(true);
  });

  it('writes queued NDJSON entries to file in order', async () => {
    const svc = new AuditService({
      enabled: true,
      filePath: TEST_FILE,
      maxFileSizeMB: 50,
      retentionDays: 90,
    });

    svc.log(makeEntry({ path: '/inventory' }));
    svc.log(makeEntry({ path: '/inventory/123' }));
    expect(existsSync(TEST_FILE)).toBe(false);

    await svc.flush();

    const content = readFileSync(TEST_FILE, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toHaveProperty('path', '/inventory');
  });

  it('does not write when disabled', () => {
    const svc = new AuditService({
      enabled: false,
      filePath: TEST_FILE,
      maxFileSizeMB: 50,
      retentionDays: 90,
    });

    svc.log(makeEntry());
    expect(existsSync(TEST_FILE)).toBe(false);
  });

  it('does not throw when the audit file cannot be appended', async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const logger = { warn: vi.fn() };
    const svc = new AuditService(
      {
        enabled: true,
        // A directory is never a valid append target, which reliably models
        // disk/permission failures without depending on the test user's UID.
        filePath: TEST_DIR,
        maxFileSizeMB: 50,
        retentionDays: 90,
      },
      logger,
    );

    expect(() => svc.log(makeEntry())).not.toThrow();
    await svc.flush();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), filePath: TEST_DIR }),
      'Failed to append audit log',
    );
  });

  it('preserves rotation while processing queued writes', async () => {
    const svc = new AuditService({
      enabled: true,
      filePath: TEST_FILE,
      maxFileSizeMB: 0.000_001,
      retentionDays: 90,
    });

    svc.log(makeEntry({ path: '/inventory/first' }));
    svc.log(makeEntry({ path: '/inventory/second' }));
    await svc.flush();

    expect(readFileSync(`${TEST_FILE}.1`, 'utf-8')).toContain('/inventory/first');
    expect(readFileSync(TEST_FILE, 'utf-8')).toContain('/inventory/second');
  });

  it('prunes expired rotated logs without requiring a size-triggered rotation', async () => {
    const svc = new AuditService({
      enabled: true,
      filePath: TEST_FILE,
      maxFileSizeMB: 50,
      retentionDays: 90,
    });
    const expiredFile = `${TEST_FILE}.1`;
    writeFileSync(TEST_FILE, '', 'utf8');
    writeFileSync(expiredFile, 'expired audit entry\n', 'utf8');
    const expiredAt = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    utimesSync(expiredFile, expiredAt, expiredAt);

    svc.log(makeEntry());
    await svc.flush();

    expect(existsSync(expiredFile)).toBe(false);
  });

  it('queries entries with pagination', async () => {
    const svc = new AuditService({
      enabled: true,
      filePath: TEST_FILE,
      maxFileSizeMB: 50,
      retentionDays: 90,
    });

    for (let i = 0; i < 5; i++) {
      svc.log(makeEntry({ items: i }));
    }

    const result = await svc.query({ page: 1, pageSize: 2 });
    expect(result.total).toBe(5);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((entry) => entry.items)).toEqual([4, 3]);
  });

  it('returns empty result when file does not exist', async () => {
    const svc = new AuditService({
      enabled: true,
      filePath: join(TEST_DIR, 'nonexistent.log'),
      maxFileSizeMB: 50,
      retentionDays: 90,
    });

    const result = await svc.query({ page: 1, pageSize: 10 });
    expect(result).toEqual({ entries: [], total: 0, totalIsCapped: false });
  });

  it('filters by since parameter', async () => {
    const svc = new AuditService({
      enabled: true,
      filePath: TEST_FILE,
      maxFileSizeMB: 50,
      retentionDays: 90,
    });

    svc.log(makeEntry({ ts: '2026-01-01T00:00:00Z' }));
    svc.log(makeEntry({ ts: '2026-02-01T00:00:00Z' }));
    svc.log(makeEntry({ ts: '2026-03-01T00:00:00Z' }));

    const result = await svc.query({
      page: 1,
      pageSize: 10,
      since: '2026-02-01T00:00:00Z',
    });
    expect(result.total).toBe(2);
  });

  it('queries rotated logs in newest-first order', async () => {
    const svc = new AuditService({
      enabled: true,
      filePath: TEST_FILE,
      maxFileSizeMB: 50,
      retentionDays: 90,
    });
    writeFileSync(TEST_FILE, `${JSON.stringify(makeEntry({ items: 3 }))}\n`, 'utf8');
    writeFileSync(
      `${TEST_FILE}.1`,
      `${JSON.stringify(makeEntry({ items: 1 }))}\n${JSON.stringify(makeEntry({ items: 2 }))}\n`,
      'utf8',
    );

    const result = await svc.query({ page: 2, pageSize: 2 });

    expect(result).toMatchObject({ total: 3, totalIsCapped: false });
    expect(result.entries.map((entry) => entry.items)).toEqual([1]);
  });

  it('stops at the since boundary without applying a line-count cap', async () => {
    const svc = new AuditService({
      enabled: true,
      filePath: TEST_FILE,
      maxFileSizeMB: 50,
      retentionDays: 90,
    });
    const entries = Array.from({ length: 2_000 }, (_, items) =>
      JSON.stringify(makeEntry({ items, ts: '2026-01-01T00:00:00Z' })),
    );
    writeFileSync(TEST_FILE, `${entries.join('\n')}\n`, 'utf8');

    const result = await svc.query({
      page: 1,
      pageSize: 10,
      since: '9999-01-01T00:00:00Z',
    });

    expect(result).toEqual({ entries: [], total: 0, totalIsCapped: false });
  });

  it('reads pages across chunks without a line-count cap', async () => {
    const svc = new AuditService({
      enabled: true,
      filePath: TEST_FILE,
      maxFileSizeMB: 50,
      retentionDays: 90,
    });
    const entries = Array.from({ length: 2_000 }, (_, items) =>
      JSON.stringify(makeEntry({ items, path: `/inventory/${items}/مرحبا` })),
    );
    entries.splice(1_750, 0, '{malformed');
    writeFileSync(TEST_FILE, `${entries.join('\n')}\n`, 'utf8');

    const result = await svc.query({ page: 10, pageSize: 25 });

    expect(result.total).toBe(2_000);
    expect(result.totalIsCapped).toBe(false);
    expect(result.entries.map((entry) => entry.items)).toEqual(
      Array.from({ length: 25 }, (_, index) => 1_774 - index),
    );
    expect(result.entries[0]?.path).toBe('/inventory/1774/مرحبا');
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIT_QUERY_COUNT_LIMIT, AuditService, type AuditEntry } from '../audit.service.js';

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
      maxFiles: 10,
      retentionDays: 90,
    });
    expect(existsSync(TEST_DIR)).toBe(true);
  });

  it('writes queued NDJSON entries to file in order', async () => {
    const svc = new AuditService({
      enabled: true,
      filePath: TEST_FILE,
      maxFileSizeMB: 50,
      maxFiles: 10,
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
      maxFiles: 10,
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
        maxFiles: 10,
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
    expect(svc.getHealth()).toMatchObject({
      enabled: true,
      ok: false,
      error: expect.stringContaining('EISDIR'),
    });

    rmSync(TEST_DIR, { recursive: true });
    svc.log(makeEntry());
    await svc.flush();

    expect(svc.getHealth()).toMatchObject({ enabled: true, ok: true });
    expect(svc.getHealth().lastSuccessfulAppendAt).toEqual(expect.any(String));
  });

  it('reports disabled audit logging as healthy but disabled', () => {
    const svc = new AuditService({
      enabled: false,
      filePath: TEST_FILE,
      maxFileSizeMB: 50,
      maxFiles: 10,
      retentionDays: 90,
    });

    expect(svc.getHealth()).toEqual({ enabled: false, ok: true });
  });

  it('preserves rotation while processing queued writes', async () => {
    const svc = new AuditService({
      enabled: true,
      filePath: TEST_FILE,
      maxFileSizeMB: 0.000_001,
      maxFiles: 10,
      retentionDays: 90,
    });

    svc.log(makeEntry({ path: '/inventory/first' }));
    svc.log(makeEntry({ path: '/inventory/second' }));
    await svc.flush();

    expect(readFileSync(`${TEST_FILE}.1`, 'utf-8')).toContain('/inventory/first');
    expect(readFileSync(TEST_FILE, 'utf-8')).toContain('/inventory/second');
  });

  it('uses maxFiles for rotation and warns once when it overwrites recent history', async () => {
    const logger = { warn: vi.fn() };
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(TEST_FILE, `${JSON.stringify(makeEntry({ path: '/inventory/live' }))}\n`, 'utf8');
    writeFileSync(
      `${TEST_FILE}.1`,
      `${JSON.stringify(makeEntry({ path: '/inventory/previous' }))}\n`,
      'utf8',
    );
    writeFileSync(
      `${TEST_FILE}.2`,
      `${JSON.stringify(makeEntry({ path: '/inventory/oldest' }))}\n`,
      'utf8',
    );
    const svc = new AuditService(
      {
        enabled: true,
        filePath: TEST_FILE,
        maxFileSizeMB: 0.000_001,
        maxFiles: 2,
        retentionDays: 90,
      },
      logger,
    );

    svc.log(makeEntry({ path: '/inventory/first' }));
    svc.log(makeEntry({ path: '/inventory/second' }));
    await svc.flush();

    expect(readFileSync(`${TEST_FILE}.2`, 'utf-8')).toContain('/inventory/live');
    expect(readFileSync(`${TEST_FILE}.2`, 'utf-8')).not.toContain('/inventory/oldest');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: TEST_FILE, maxFiles: 2, retentionDays: 90 }),
      expect.stringContaining('discarding a file before its retention period'),
    );
  });

  it('prunes expired rotated logs without requiring a size-triggered rotation', async () => {
    const svc = new AuditService({
      enabled: true,
      filePath: TEST_FILE,
      maxFileSizeMB: 50,
      maxFiles: 10,
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

  it('prunes expired entries from the active log without requiring a size-triggered rotation', async () => {
    const svc = new AuditService({
      enabled: true,
      filePath: TEST_FILE,
      maxFileSizeMB: 50,
      maxFiles: 10,
      retentionDays: 1,
    });
    const expiredEntry = makeEntry({
      path: '/inventory/expired',
      ts: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const retainedEntry = makeEntry({ path: '/inventory/retained' });
    writeFileSync(
      TEST_FILE,
      `${JSON.stringify(expiredEntry)}\n${JSON.stringify(retainedEntry)}\n`,
      'utf8',
    );

    svc.log(makeEntry({ path: '/inventory/appended' }));
    await svc.flush();

    const entries = readFileSync(TEST_FILE, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as AuditEntry);
    expect(entries.map((entry) => entry.path)).toEqual([
      '/inventory/retained',
      '/inventory/appended',
    ]);
  });

  it('queries entries with pagination', async () => {
    const svc = new AuditService({
      enabled: true,
      filePath: TEST_FILE,
      maxFileSizeMB: 50,
      maxFiles: 10,
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
      maxFiles: 10,
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
      maxFiles: 10,
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
      maxFiles: 10,
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
      maxFiles: 10,
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

  it('caps scans across chunks and rotated logs without hiding the requested page', async () => {
    const svc = new AuditService({
      enabled: true,
      filePath: TEST_FILE,
      maxFileSizeMB: 50,
      maxFiles: 10,
      retentionDays: 90,
    });
    const entries = Array.from({ length: 2_000 }, (_, items) =>
      JSON.stringify(makeEntry({ items, path: `/inventory/${items}/مرحبا` })),
    );
    writeFileSync(TEST_FILE, `${entries.slice(1_500).join('\n')}\n`, 'utf8');
    writeFileSync(`${TEST_FILE}.1`, `${entries.slice(0, 1_500).join('\n')}\n`, 'utf8');

    const result = await svc.query({ page: 10, pageSize: 25 });

    expect(result.total).toBe(AUDIT_QUERY_COUNT_LIMIT);
    expect(result.totalIsCapped).toBe(true);
    expect(result.entries.map((entry) => entry.items)).toEqual(
      Array.from({ length: 25 }, (_, index) => 1_774 - index),
    );
    expect(result.entries[0]?.path).toBe('/inventory/1774/مرحبا');
  });
});

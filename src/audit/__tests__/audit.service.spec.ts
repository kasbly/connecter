import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
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

  it('writes NDJSON entries to file', () => {
    const svc = new AuditService({
      enabled: true,
      filePath: TEST_FILE,
      maxFileSizeMB: 50,
      retentionDays: 90,
    });

    svc.log(makeEntry({ path: '/inventory' }));
    svc.log(makeEntry({ path: '/inventory/123' }));

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

  it('queries entries with pagination', () => {
    const svc = new AuditService({
      enabled: true,
      filePath: TEST_FILE,
      maxFileSizeMB: 50,
      retentionDays: 90,
    });

    for (let i = 0; i < 5; i++) {
      svc.log(makeEntry({ items: i }));
    }

    const result = svc.query({ page: 1, pageSize: 2 });
    expect(result.total).toBe(5);
    expect(result.entries).toHaveLength(2);
  });

  it('returns empty result when file does not exist', () => {
    const svc = new AuditService({
      enabled: true,
      filePath: join(TEST_DIR, 'nonexistent.log'),
      maxFileSizeMB: 50,
      retentionDays: 90,
    });

    const result = svc.query({ page: 1, pageSize: 10 });
    expect(result.entries).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('filters by since parameter', () => {
    const svc = new AuditService({
      enabled: true,
      filePath: TEST_FILE,
      maxFileSizeMB: 50,
      retentionDays: 90,
    });

    svc.log(makeEntry({ ts: '2026-01-01T00:00:00Z' }));
    svc.log(makeEntry({ ts: '2026-02-01T00:00:00Z' }));
    svc.log(makeEntry({ ts: '2026-03-01T00:00:00Z' }));

    const result = svc.query({
      page: 1,
      pageSize: 10,
      since: '2026-02-01T00:00:00Z',
    });
    expect(result.total).toBe(2);
  });
});

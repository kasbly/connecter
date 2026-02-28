import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import type { DatabaseAdapter, QueryResult } from '../../db/adapter.interface.js';
import type { InventoryResourceConfig } from '../../config/config.types.js';
import { AuditService } from '../../audit/audit.service.js';
import { registerInventoryRoutes } from '../inventory.route.js';

function createMockDbAdapter(overrides: Partial<DatabaseAdapter> = {}): DatabaseAdapter {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    query: vi.fn().mockResolvedValue({ rows: [], total: 0 } satisfies QueryResult),
    queryById: vi.fn().mockResolvedValue(null),
    queryRelation: vi.fn().mockResolvedValue(new Map()),
    healthCheck: vi.fn().mockResolvedValue(true),
    introspect: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

const testConfig: InventoryResourceConfig = {
  table: 'Product',
  idColumn: 'id',
  updatedAtColumn: 'updatedAt',
  fields: {
    externalId: 'id',
    title: 'name',
    price: 'price',
    currency: "'USD'",
    category: "'item'",
  },
  searchableColumns: ['name'],
  filterableColumns: {
    category: { column: 'category', type: 'string' },
  },
};

describe('inventory routes', () => {
  let auditService: AuditService;

  beforeEach(() => {
    auditService = new AuditService({ enabled: false, filePath: '', maxFileSizeMB: 50, retentionDays: 90 });
  });

  it('GET /inventory returns paginated response', async () => {
    const mockAdapter = createMockDbAdapter({
      query: vi.fn().mockResolvedValue({
        rows: [
          { id: '1', name: 'Widget', price: 9.99, updatedAt: '2026-01-01T00:00:00Z' },
          { id: '2', name: 'Gadget', price: 19.99, updatedAt: '2026-01-02T00:00:00Z' },
        ],
        total: 2,
      }),
    });

    const app = Fastify();
    registerInventoryRoutes(app, {
      dbAdapter: mockAdapter,
      resourceConfig: testConfig,
      auditService,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/inventory',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as { items: unknown[]; total: number; page: number };
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    expect(body.page).toBe(1);

    await app.close();
  });

  it('GET /inventory/:id returns 404 for missing item', async () => {
    const mockAdapter = createMockDbAdapter({
      queryById: vi.fn().mockResolvedValue(null),
    });

    const app = Fastify();
    registerInventoryRoutes(app, {
      dbAdapter: mockAdapter,
      resourceConfig: testConfig,
      auditService,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/inventory/999',
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.payload) as { error: string };
    expect(body.error).toBe('Item not found');

    await app.close();
  });

  it('GET /inventory/:id returns item when found', async () => {
    const mockAdapter = createMockDbAdapter({
      queryById: vi.fn().mockResolvedValue({
        id: '42',
        name: 'Test Item',
        price: 99.99,
        updatedAt: '2026-02-01T00:00:00Z',
      }),
    });

    const app = Fastify();
    registerInventoryRoutes(app, {
      dbAdapter: mockAdapter,
      resourceConfig: testConfig,
      auditService,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/inventory/42',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as { externalId: string; title: string };
    expect(body.externalId).toBe('42');
    expect(body.title).toBe('Test Item');

    await app.close();
  });
});

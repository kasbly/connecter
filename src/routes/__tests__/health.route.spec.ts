import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter.interface.js';
import { buildQuery } from '../../mapping/query-builder.js';
import {
  SEARCHABLE_COLUMN_PROBE_TERM,
  UNKNOWN_STATUS_SCAN_LIMIT,
  UNKNOWN_STATUS_VALUE_LIMIT,
  createResourceHealthCheck,
  formatUnknownStatusWarning,
  formatWireContractViolationWarning,
  probeInventoryResource,
  registerHealthRoute,
} from '../health.route.js';

const inventoryResource = {
  table: 'inventory',
  idColumn: 'id',
  fields: { title: 'title', price: 'price', currency: "'SAR'" },
};

function createHealthAdapter(healthy: boolean, resourceHealthy = true): DatabaseAdapter {
  return {
    healthCheck: vi.fn().mockResolvedValue(healthy),
    query: resourceHealthy
      ? vi.fn().mockResolvedValue({ rows: [], total: 0 })
      : vi.fn().mockRejectedValue(new Error('column "price" does not exist')),
  } as unknown as DatabaseAdapter;
}

describe('health route', () => {
  it('returns 200 when the database is connected', async () => {
    const app = Fastify();
    const dbAdapter = createHealthAdapter(true);
    registerHealthRoute(app, dbAdapter, createResourceHealthCheck(dbAdapter, inventoryResource));

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      database: 'connected',
      resources: 'ok',
      audit: 'disabled',
    });
    await app.close();
  });

  it('returns 503 when the database is disconnected', async () => {
    const app = Fastify();
    const dbAdapter = createHealthAdapter(false);
    registerHealthRoute(app, dbAdapter, createResourceHealthCheck(dbAdapter, inventoryResource));

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'degraded',
      database: 'disconnected',
      resources: 'unavailable',
    });
    await app.close();
  });

  it('returns 503 with resource probe details when the inventory mapping is invalid', async () => {
    const app = Fastify();
    const dbAdapter = createHealthAdapter(true, false);
    registerHealthRoute(app, dbAdapter, createResourceHealthCheck(dbAdapter, inventoryResource));

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'degraded',
      database: 'connected',
      resources: 'misconfigured',
      resourceError: expect.stringContaining('column "price" does not exist'),
    });
    await app.close();
  });

  it('returns 503 with audit details when enabled audit logging cannot persist', async () => {
    const app = Fastify();
    const dbAdapter = createHealthAdapter(true);
    registerHealthRoute(
      app,
      dbAdapter,
      createResourceHealthCheck(dbAdapter, inventoryResource),
      () => ({ enabled: true, ok: false, error: 'EACCES: permission denied' }),
    );

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'degraded',
      audit: 'degraded',
      auditError: 'EACCES: permission denied',
    });
    await app.close();
  });

  it('probes configured columns and every relation before reporting healthy', async () => {
    const dbAdapter = createHealthAdapter(true);
    dbAdapter.queryRelation = vi.fn().mockResolvedValue(new Map());
    const resource = {
      ...inventoryResource,
      baseFilter: 'published = true',
      searchableColumns: ['sku'],
      filterableColumns: { condition: { column: 'condition', type: 'string' as const } },
      relations: {
        images: {
          table: 'images',
          foreignKey: 'inventory_id',
          referenceKey: 'id',
          fields: { url: 'url' },
          orderBy: { column: 'position', direction: 'asc' as const },
        },
      },
    };

    await probeInventoryResource(dbAdapter, resource);

    expect(dbAdapter.query).toHaveBeenNthCalledWith(
      1,
      'inventory',
      [],
      { page: 1, pageSize: 20 },
      { column: 'id', direction: 'desc' },
      'published = true',
      expect.arrayContaining(['id', 'title', 'price', 'sku', 'condition']),
    );
    expect(dbAdapter.query).toHaveBeenNthCalledWith(
      2,
      'inventory',
      [
        {
          column: 'sku',
          operator: 'ILIKE',
          value: SEARCHABLE_COLUMN_PROBE_TERM,
          _group: SEARCHABLE_COLUMN_PROBE_TERM,
        },
      ],
      { page: 1, pageSize: 1 },
      { column: 'id', direction: 'desc' },
      'published = true',
      expect.arrayContaining(['id', 'title', 'price', 'sku', 'condition']),
    );
    expect(dbAdapter.queryRelation).toHaveBeenCalledWith({
      table: 'images',
      foreignKey: 'inventory_id',
      parentIds: [],
      fields: { url: 'url' },
      filter: undefined,
      orderBy: { column: 'position', direction: 'asc' },
    });
  });

  it('fails the resource when a searchable column cannot be used with ILIKE', async () => {
    const app = Fastify();
    const dbAdapter = createHealthAdapter(true);
    vi.mocked(dbAdapter.query).mockImplementation(async (_table, conditions) => {
      if (
        conditions.some(
          (condition) => condition.operator === 'ILIKE' && condition.column === 'state',
        )
      ) {
        throw Object.assign(new Error('operator does not exist: integer ~~* unknown'), {
          code: '42883',
        });
      }
      return { rows: [{ id: '1', title: 'Item', price: 100, name: 'Item', state: 1 }], total: 1 };
    });
    registerHealthRoute(
      app,
      dbAdapter,
      createResourceHealthCheck(dbAdapter, {
        ...inventoryResource,
        searchableColumns: ['name', 'state'],
      }),
    );

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'degraded',
      database: 'connected',
      resources: 'misconfigured',
      resourceError: expect.stringContaining('operator does not exist'),
    });
    await app.close();
  });

  it('reports an observed source status that has not been mapped', async () => {
    const app = Fastify();
    const dbAdapter = createHealthAdapter(true);
    vi.mocked(dbAdapter.query).mockResolvedValueOnce({
      rows: [{ id: '1', title: 'Test', price: 100, availability: 'discontinued' }],
      total: 1,
    });
    registerHealthRoute(
      app,
      dbAdapter,
      createResourceHealthCheck(dbAdapter, {
        ...inventoryResource,
        fields: { ...inventoryResource.fields, status: 'availability' },
        statusValues: { ACTIVE: ['for_sale'], SOLD: ['sold_out'] },
      }),
    );

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      unknownStatusValues: ['discontinued'],
    });
    await app.close();
  });

  it('reports unmapped statuses the sampled row never carried', async () => {
    const app = Fastify();
    const dbAdapter = createHealthAdapter(true);
    // The one row the mapping probe samples is mapped; the bulk of the
    // catalogue is not (#23293).
    vi.mocked(dbAdapter.query).mockResolvedValueOnce({
      rows: [{ id: '1', title: 'Test', price: 100, availability: 'for_sale' }],
      total: 10_000,
    });
    dbAdapter.distinctValues = vi
      .fn()
      .mockResolvedValue(['for_sale', 'sold_out', 'under_offer', null, '  ']);
    registerHealthRoute(
      app,
      dbAdapter,
      createResourceHealthCheck(dbAdapter, {
        ...inventoryResource,
        baseFilter: 'published = true',
        fields: { ...inventoryResource.fields, status: 'availability' },
        statusValues: { ACTIVE: ['for_sale'], SOLD: ['sold_out'] },
      }),
    );

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(dbAdapter.distinctValues).toHaveBeenCalledWith({
      table: 'inventory',
      column: 'availability',
      limit: UNKNOWN_STATUS_VALUE_LIMIT,
      scanLimit: UNKNOWN_STATUS_SCAN_LIMIT,
      baseFilter: 'published = true',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      resources: 'ok',
      unknownStatusValues: ['under_offer'],
    });
    await app.close();
  });

  it('stays healthy when the distinct-status diagnostic fails', async () => {
    const dbAdapter = createHealthAdapter(true);
    vi.mocked(dbAdapter.query).mockResolvedValueOnce({
      rows: [{ id: '1', title: 'Test', price: 100, availability: 'discontinued' }],
      total: 1,
    });
    dbAdapter.distinctValues = vi.fn().mockRejectedValue(new Error('statement timeout'));

    const result = await probeInventoryResource(dbAdapter, {
      ...inventoryResource,
      fields: { ...inventoryResource.fields, status: 'availability' },
      statusValues: { ACTIVE: ['for_sale'] },
    });

    expect(result.unknownStatusValues).toEqual(['discontinued']);
    expect(result.wireContractViolationIds).toEqual([]);
  });

  it('samples a full default inventory page using the same sort as GET /inventory', async () => {
    const dbAdapter = createHealthAdapter(true);
    const resource = { ...inventoryResource, updatedAtColumn: 'updated_at' };

    await probeInventoryResource(dbAdapter, resource);

    const listSort = buildQuery({ page: '1', pageSize: '1' }, resource).sort;
    // Includes the id tiebreaker (#24914): the probe must read the same
    // deterministic first page GET /inventory serves.
    expect(listSort).toEqual({ column: 'updated_at', direction: 'desc', tiebreaker: 'id' });
    expect(dbAdapter.query).toHaveBeenCalledWith(
      'inventory',
      [],
      { page: 1, pageSize: 20 },
      listSort,
      undefined,
      expect.any(Array),
    );
  });

  it('withholds a wire-contract-violating row and stays healthy when other sampled rows are valid', async () => {
    const app = Fastify();
    const dbAdapter = createHealthAdapter(true);
    vi.mocked(dbAdapter.query).mockResolvedValueOnce({
      rows: [
        { id: '1', title: 'Valid listing', price: 1250 },
        { id: '2', title: 'Invalid listing', price: 'SAR 1,250' },
      ],
      total: 2,
    });
    registerHealthRoute(app, dbAdapter, createResourceHealthCheck(dbAdapter, inventoryResource));

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      resources: 'ok',
      wireContractViolationIds: ['2'],
    });
    await app.close();
  });

  it('fails the resource when every sampled row violates the wire contract', async () => {
    const app = Fastify();
    const dbAdapter = createHealthAdapter(true);
    vi.mocked(dbAdapter.query).mockResolvedValueOnce({
      rows: [
        { id: '1', title: 'Invalid listing', price: 'SAR 1,250' },
        { id: '2', title: 'Also invalid', price: null },
      ],
      total: 2,
    });
    registerHealthRoute(app, dbAdapter, createResourceHealthCheck(dbAdapter, inventoryResource));

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      resources: 'misconfigured',
      resourceError: expect.stringContaining('price'),
    });
    await app.close();
  });

  it('reports malformed configured image values from a sample row', async () => {
    const app = Fastify();
    const dbAdapter = createHealthAdapter(true);
    vi.mocked(dbAdapter.query).mockResolvedValueOnce({
      rows: [
        { id: '1', title: 'Test', price: 100, image_urls: '["https://example.com/a.jpg", 1]' },
      ],
      total: 1,
    });
    registerHealthRoute(
      app,
      dbAdapter,
      createResourceHealthCheck(dbAdapter, {
        ...inventoryResource,
        fields: { ...inventoryResource.fields, images: 'image_urls' },
      }),
    );

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ resourceError: expect.stringContaining('images[1]') });
    await app.close();
  });

  it('names the unmapped values and the status they are reported as', () => {
    expect(formatUnknownStatusWarning(['under_offer'], 'RESERVED')).toContain('"under_offer"');
    expect(formatUnknownStatusWarning(['under_offer'], 'RESERVED')).toContain('RESERVED');
    expect(formatUnknownStatusWarning(['under_offer'], undefined)).toContain('DRAFT');
    expect(formatUnknownStatusWarning([], 'DRAFT')).toBeNull();
  });

  it('names the withheld listings for a wire-contract-violation warning', () => {
    expect(formatWireContractViolationWarning(['42'])).toContain('"42"');
    expect(formatWireContractViolationWarning([])).toBeNull();
  });

  it('caches a successful resource probe across health checks', async () => {
    const app = Fastify();
    const dbAdapter = createHealthAdapter(true);
    registerHealthRoute(app, dbAdapter, createResourceHealthCheck(dbAdapter, inventoryResource));

    await app.inject({ method: 'GET', url: '/health' });
    await app.inject({ method: 'GET', url: '/health' });

    expect(dbAdapter.query).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

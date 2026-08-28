import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter.interface.js';
import { buildQuery } from '../../mapping/query-builder.js';
import {
  UNKNOWN_STATUS_SCAN_LIMIT,
  UNKNOWN_STATUS_VALUE_LIMIT,
  createResourceHealthCheck,
  formatUnknownStatusWarning,
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

    expect(dbAdapter.query).toHaveBeenCalledWith(
      'inventory',
      [],
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

    const unknownStatusValues = await probeInventoryResource(dbAdapter, {
      ...inventoryResource,
      fields: { ...inventoryResource.fields, status: 'availability' },
      statusValues: { ACTIVE: ['for_sale'] },
    });

    expect(unknownStatusValues).toEqual(['discontinued']);
  });

  it('samples the same default sort GET /inventory uses without sortBy', async () => {
    const dbAdapter = createHealthAdapter(true);
    const resource = { ...inventoryResource, updatedAtColumn: 'updated_at' };

    await probeInventoryResource(dbAdapter, resource);

    const listSort = buildQuery({ page: '1', pageSize: '1' }, resource).sort;
    expect(listSort).toEqual({ column: 'updated_at', direction: 'desc' });
    expect(dbAdapter.query).toHaveBeenCalledWith(
      'inventory',
      [],
      { page: 1, pageSize: 1 },
      listSort,
      undefined,
      expect.any(Array),
    );
  });

  it('reports a field-specific error when a mapped sample cannot satisfy the wire contract', async () => {
    const app = Fastify();
    const dbAdapter = createHealthAdapter(true);
    vi.mocked(dbAdapter.query).mockResolvedValueOnce({
      rows: [{ id: '1', title: 'Test', price: 'SAR 1,250' }],
      total: 1,
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

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
  formatUnservableImageWarning,
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
    dbAdapter.probeSearchableColumns = vi.fn().mockResolvedValue(undefined);
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

    expect(dbAdapter.query).toHaveBeenCalledTimes(1);
    expect(dbAdapter.query).toHaveBeenNthCalledWith(
      1,
      'inventory',
      [],
      { page: 1, pageSize: 20 },
      { column: 'id', direction: 'desc' },
      'published = true',
      expect.arrayContaining(['id', 'title', 'price', 'sku', 'condition']),
    );
    // The searchable-column check is a dedicated zero-row probe, not a second
    // real page query — it must never re-enter `dbAdapter.query` (#26342).
    expect(dbAdapter.probeSearchableColumns).toHaveBeenCalledTimes(1);
    expect(dbAdapter.probeSearchableColumns).toHaveBeenCalledWith({
      table: 'inventory',
      columns: ['sku'],
      probeTerm: SEARCHABLE_COLUMN_PROBE_TERM,
      baseFilter: 'published = true',
    });
    expect(dbAdapter.queryRelation).toHaveBeenCalledWith({
      table: 'images',
      foreignKey: 'inventory_id',
      parentIds: [],
      fields: { url: 'url' },
      filter: undefined,
      orderBy: { column: 'position', direction: 'asc' },
    });
  });

  it('fails the resource when a searchable column cannot be used with ILIKE, via a non-executing probe (#26342)', async () => {
    const app = Fastify();
    const dbAdapter = createHealthAdapter(true);
    const probeSearchableColumns = vi.fn().mockRejectedValue(
      Object.assign(new Error('operator does not exist: integer ~~* unknown'), {
        code: '42883',
      }),
    );
    dbAdapter.probeSearchableColumns = probeSearchableColumns;
    registerHealthRoute(
      app,
      dbAdapter,
      createResourceHealthCheck(dbAdapter, {
        ...inventoryResource,
        searchableColumns: ['name', 'state'],
      }),
    );

    const response = await app.inject({ method: 'GET', url: '/health' });

    // The probe never touches `dbAdapter.query` a second time — it is a
    // dedicated, non-executing statement (no page query, no count query) —
    // yet it still surfaces the operator-resolution error for a non-text
    // column so a `state` (integer) column pointed at as searchable is still
    // caught.
    expect(dbAdapter.query).toHaveBeenCalledTimes(1);
    expect(probeSearchableColumns).toHaveBeenCalledWith({
      table: 'inventory',
      columns: ['name', 'state'],
      probeTerm: SEARCHABLE_COLUMN_PROBE_TERM,
    });
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
      // No updatedAtColumn configured on `inventoryResource`, so the scan
      // falls back to id-descending (#25985).
      orderBy: { column: 'id', direction: 'desc' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      resources: 'ok',
      unknownStatusValues: ['under_offer'],
    });
    await app.close();
  });

  it('orders the distinct-status scan by recency when an updatedAtColumn is configured, so a status that only landed on a mid-catalogue row is not hidden behind heap order (#25985)', async () => {
    const app = Fastify();
    const dbAdapter = createHealthAdapter(true);
    // The sampled page (the newest rows) never carries `under_offer` — it
    // only shows up on a row that was updated after the scan cap would have
    // been reached in unordered (heap) order. Ordering the scan by
    // `updatedAt DESC` — the same recency order the sampled page uses — is
    // what lets the diagnostic see it on a large catalogue.
    vi.mocked(dbAdapter.query).mockResolvedValueOnce({
      rows: [{ id: '1', title: 'Test', price: 100, availability: 'for_sale' }],
      total: 10_000,
    });
    dbAdapter.distinctValues = vi.fn().mockResolvedValue(['for_sale', 'under_offer']);
    registerHealthRoute(
      app,
      dbAdapter,
      createResourceHealthCheck(dbAdapter, {
        ...inventoryResource,
        updatedAtColumn: 'updated_at',
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
      orderBy: { column: 'updated_at', direction: 'desc', tiebreaker: 'id' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
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

  it('stays healthy when the first sampled page is fully invalid but the second page has a valid row', async () => {
    const app = Fastify();
    const dbAdapter = createHealthAdapter(true);
    vi.mocked(dbAdapter.query)
      .mockResolvedValueOnce({
        rows: [
          { id: '1', title: 'Bad import row', price: 'SAR 1,250' },
          { id: '2', title: 'Also bad import row', price: null },
        ],
        total: 20_002,
      })
      .mockResolvedValueOnce({
        rows: [
          { id: '3', title: 'Valid listing', price: 999 },
          { id: '4', title: 'Another bad row', price: 'SAR 50' },
        ],
        total: 20_002,
      });
    registerHealthRoute(app, dbAdapter, createResourceHealthCheck(dbAdapter, inventoryResource));

    const response = await app.inject({ method: 'GET', url: '/health' });

    // A contiguous bad import batch fills exactly the first `updatedAt DESC`
    // page while the rest of a large catalog is fine — that must not take
    // GET /inventory offline for every listing (#25983).
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      resources: 'ok',
      wireContractViolationIds: ['1', '2', '4'],
    });
    expect(dbAdapter.query).toHaveBeenNthCalledWith(
      2,
      'inventory',
      [],
      { page: 2, pageSize: 20 },
      expect.any(Object),
      undefined,
      expect.any(Array),
    );
    await app.close();
  });

  it('fails the resource when both the first and second sampled pages are fully invalid', async () => {
    const app = Fastify();
    const dbAdapter = createHealthAdapter(true);
    vi.mocked(dbAdapter.query)
      .mockResolvedValueOnce({
        rows: [{ id: '1', title: 'Invalid listing', price: 'SAR 1,250' }],
        total: 40,
      })
      .mockResolvedValueOnce({
        rows: [{ id: '21', title: 'Also invalid', price: 'SAR 999' }],
        total: 40,
      });
    registerHealthRoute(app, dbAdapter, createResourceHealthCheck(dbAdapter, inventoryResource));

    const response = await app.inject({ method: 'GET', url: '/health' });

    // Every row on both pages fails the same way — a systematic mapping
    // break (e.g. price pointed at a text column) — so the resource must
    // still be reported misconfigured rather than served as healthy.
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      resources: 'misconfigured',
      resourceError: expect.stringContaining('price'),
    });
    await app.close();
  });

  it('fails the resource when every sampled row on both pages carries a malformed relation image value', async () => {
    const app = Fastify();
    const dbAdapter = createHealthAdapter(true);
    vi.mocked(dbAdapter.query)
      .mockResolvedValueOnce({
        rows: [
          { id: '1', title: 'Listing 1', price: 100 },
          { id: '2', title: 'Listing 2', price: 200 },
        ],
        total: 4,
      })
      .mockResolvedValueOnce({
        rows: [
          { id: '3', title: 'Listing 3', price: 300 },
          { id: '4', title: 'Listing 4', price: 400 },
        ],
        total: 4,
      });
    dbAdapter.queryRelation = vi
      .fn()
      .mockResolvedValueOnce(
        new Map([
          ['1', [{ image_url: { url: 'https://example.com/a.jpg' } }]],
          ['2', [{ image_url: { url: 'https://example.com/b.jpg' } }]],
        ]),
      )
      .mockResolvedValueOnce(
        new Map([
          ['3', [{ image_url: { url: 'https://example.com/c.jpg' } }]],
          ['4', [{ image_url: { url: 'https://example.com/d.jpg' } }]],
        ]),
      );
    registerHealthRoute(
      app,
      dbAdapter,
      createResourceHealthCheck(dbAdapter, {
        ...inventoryResource,
        relations: {
          photos: {
            table: 'images',
            foreignKey: 'inventory_id',
            referenceKey: 'id',
            fields: { image_url: 'image_url' },
            imageUrlField: 'image_url',
          },
        },
      }),
    );

    const response = await app.inject({ method: 'GET', url: '/health' });

    // Every row on both pages has a relation image value that is a jsonb
    // object rather than a string, which the wire contract rejects as
    // malformed. Evaluating page 2 against page 1's relation data (keyed by
    // ids "1"/"2") would resolve every page-2 lookup to no relation rows,
    // hide the malformed value, and let the probe fail open exactly where
    // this second-page check exists to catch it (residual of #25983).
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      resources: 'misconfigured',
      resourceError: expect.stringContaining('images'),
    });
    expect(dbAdapter.queryRelation).toHaveBeenCalledTimes(2);
    expect(dbAdapter.queryRelation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ parentIds: ['3', '4'] }),
    );
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

  it('keeps the resource healthy when every sampled row stores a relative image path', async () => {
    const app = Fastify();
    const dbAdapter = createHealthAdapter(true);
    vi.mocked(dbAdapter.query).mockResolvedValueOnce({
      rows: [
        {
          id: '1',
          title: 'Test',
          price: 100,
          image_urls: '/wp-content/uploads/2026/03/car-123.jpg',
        },
        { id: '2', title: 'Also test', price: 200, image_urls: 'car-456.jpg' },
      ],
      total: 2,
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

    // The WordPress/Magento shape: the photos cannot be served, but the
    // listings can. Failing the resource here 503s the whole catalog and
    // blocks setup for the most common self-hosted store (#25790).
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      resources: 'ok',
      unservableImageIds: ['1', '2'],
    });
    expect(response.json()).not.toHaveProperty('resourceError');
    expect(response.json()).not.toHaveProperty('wireContractViolationIds');
    await app.close();
  });

  it('names the listings whose image values cannot be served', () => {
    const warning = formatUnservableImageWarning(['car-123']);

    expect(warning).toContain('"car-123"');
    expect(warning).toContain('absolute http(s) URLs');
    expect(formatUnservableImageWarning([])).toBeNull();
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

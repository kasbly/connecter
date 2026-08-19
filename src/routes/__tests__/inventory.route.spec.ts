import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { DatabaseAdapter, QueryResult } from '../../db/adapter.interface.js';
import type { InventoryResourceConfig } from '../../config/config.types.js';
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
    year: { column: 'year', type: 'number' },
  },
};

const connectorInventoryFixturePath = fileURLToPath(
  new URL('../../../../../contracts/connector-inventory-response.json', import.meta.url),
);
const connectorInventoryFixture = JSON.parse(readFileSync(connectorInventoryFixturePath, 'utf8'));

describe('inventory routes', () => {
  it('GET /inventory matches the shared standalone connector wire contract', async () => {
    const mockAdapter = createMockDbAdapter({
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            id: '123',
            name: '2024 Hyundai Sonata',
            description: 'Low-mileage sedan with a full service history',
            price: 15_000_000,
            makeEn: 'Hyundai',
            year: 2024,
            updatedAt: new Date('2026-01-15T10:00:00Z'),
          },
        ],
        total: 1,
        totalIsCapped: false,
      }),
      queryRelation: vi.fn().mockImplementation(({ table }: { table: string }) => {
        if (table === 'Image')
          return Promise.resolve(new Map([['123', [{ url: 'http://img1.jpg' }]]]));
        return Promise.resolve(new Map([['123', [{ name: 'ABS' }, { name: 'Airbag' }]]]));
      }),
    });
    const config: InventoryResourceConfig = {
      ...testConfig,
      fields: {
        ...testConfig.fields,
        description: 'description',
        currency: "'KRW'",
        category: "'car'",
      },
      attributes: { makeEn: 'makeEn', year: 'year' },
      relations: {
        images: {
          table: 'Image',
          foreignKey: 'carId',
          referenceKey: 'id',
          fields: { url: 'url' },
          imageUrlField: 'url',
        },
        features: {
          table: 'Feature',
          foreignKey: 'carId',
          referenceKey: 'id',
          fields: { name: 'name' },
          flatten: 'name',
        },
      },
    };
    const app = Fastify();
    registerInventoryRoutes(app, { dbAdapter: mockAdapter, resourceConfig: config });

    const response = await app.inject({ method: 'GET', url: '/inventory?pageSize=20' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(connectorInventoryFixture);
    await app.close();
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

  it.each([
    [
      'an exact total',
      { total: 7, totalIsCapped: false } satisfies Partial<QueryResult>,
      { total: 7, totalPages: 4, totalIsCapped: false },
    ],
    [
      'a total the adapter stopped counting at its cap (#17420)',
      { total: 1000, totalIsCapped: true } satisfies Partial<QueryResult>,
      { total: 1000, totalPages: 500, totalIsCapped: true },
    ],
  ])('GET /inventory reports %s', async (_label, adapterResult, expected) => {
    const mockAdapter = createMockDbAdapter({
      query: vi.fn().mockResolvedValue({ rows: [], ...adapterResult }),
    });

    const app = Fastify();
    registerInventoryRoutes(app, {
      dbAdapter: mockAdapter,
      resourceConfig: testConfig,
    });

    const response = await app.inject({ method: 'GET', url: '/inventory?pageSize=2' });

    expect(response.statusCode).toBe(200);
    expect(response.json() as Record<string, unknown>).toMatchObject(expected);

    await app.close();
  });

  it.each([
    ['/inventory?search=first&search=second', 'Query parameter "search"'],
    ['/inventory?filter.year=not-a-number', 'Query parameter "filter.year"'],
    ['/inventory?updatedSince=not-a-date', 'Query parameter "updatedSince"'],
  ])('GET %s returns 400 without querying the database', async (url, expectedMessage) => {
    const mockAdapter = createMockDbAdapter();
    const app = Fastify();
    registerInventoryRoutes(app, {
      dbAdapter: mockAdapter,
      resourceConfig: testConfig,
    });

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { message: string }).message).toContain(expectedMessage);
    expect(mockAdapter.query).not.toHaveBeenCalled();

    await app.close();
  });

  it('GET /inventory reports unsupported filters and still queries configured filters', async () => {
    const mockAdapter = createMockDbAdapter();
    const app = Fastify();
    registerInventoryRoutes(app, {
      dbAdapter: mockAdapter,
      resourceConfig: testConfig,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/inventory?filter.minYear=2020&filter.category=item',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ignoredFilters: ['minYear'] });
    expect(mockAdapter.query).toHaveBeenCalledWith(
      'Product',
      expect.arrayContaining([
        expect.objectContaining({ column: 'category', operator: '=', value: 'item' }),
      ]),
      expect.anything(),
      expect.anything(),
      undefined,
      expect.anything(),
    );

    await app.close();
  });

  it.each([
    ['/inventory?filter.year=1.5', '22P02'],
    ['/inventory?filter.year=1e300', '22003'],
  ])('GET %s returns 400 when PostgreSQL rejects the numeric filter', async (url, code) => {
    const postgresError = Object.assign(new Error('invalid numeric input'), { code });
    const mockAdapter = createMockDbAdapter({
      query: vi.fn().mockRejectedValue(postgresError),
    });
    const app = Fastify();
    registerInventoryRoutes(app, {
      dbAdapter: mockAdapter,
      resourceConfig: testConfig,
    });

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 'A numeric filter value is invalid for its configured database column',
    });

    await app.close();
  });

  it('GET /inventory does not hide unrelated database errors', async () => {
    const mockAdapter = createMockDbAdapter({
      query: vi.fn().mockRejectedValue(new Error('connection lost')),
    });
    const app = Fastify();
    registerInventoryRoutes(app, {
      dbAdapter: mockAdapter,
      resourceConfig: testConfig,
    });

    const response = await app.inject({ method: 'GET', url: '/inventory?filter.year=2026' });

    expect(response.statusCode).toBe(500);

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

  it.each([
    ['/inventory/not-a-number', '22P02'],
    ['/inventory/99999999999', '22003'],
  ])('GET %s returns 404 when PostgreSQL rejects the ID value', async (url, code) => {
    const postgresError = Object.assign(new Error('invalid input value for integer'), { code });
    const mockAdapter = createMockDbAdapter({
      queryById: vi.fn().mockRejectedValue(postgresError),
    });

    const app = Fastify();
    registerInventoryRoutes(app, {
      dbAdapter: mockAdapter,
      resourceConfig: testConfig,
    });

    const response = await app.inject({
      method: 'GET',
      url,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Item not found' });

    await app.close();
  });

  it('GET /inventory/:id does not hide unrelated database errors', async () => {
    const mockAdapter = createMockDbAdapter({
      queryById: vi.fn().mockRejectedValue(new Error('connection lost')),
    });

    const app = Fastify();
    registerInventoryRoutes(app, {
      dbAdapter: mockAdapter,
      resourceConfig: testConfig,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/inventory/42',
    });

    expect(response.statusCode).toBe(500);

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

  it('unwraps a quoted ID column when loading relations for list and item routes', async () => {
    const quotedConfig: InventoryResourceConfig = {
      ...testConfig,
      idColumn: '"externalId"',
      fields: { ...testConfig.fields, externalId: '"externalId"' },
      relations: {
        images: {
          table: 'Image',
          foreignKey: '"productId"',
          referenceKey: '"externalId"',
          fields: { url: 'url' },
          imageUrlField: 'url',
          orderBy: { column: 'position', direction: 'asc' },
        },
      },
    };
    const queryRelation = vi.fn().mockResolvedValue(new Map());
    const row = {
      externalId: 'quoted-42',
      name: 'Test Item',
      price: 99.99,
      updatedAt: '2026-02-01T00:00:00Z',
    };
    const mockAdapter = createMockDbAdapter({
      query: vi.fn().mockResolvedValue({ rows: [row], total: 1 }),
      queryById: vi.fn().mockResolvedValue(row),
      queryRelation,
    });

    const app = Fastify();
    registerInventoryRoutes(app, {
      dbAdapter: mockAdapter,
      resourceConfig: quotedConfig,
    });

    expect((await app.inject({ method: 'GET', url: '/inventory' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/inventory/quoted-42' })).statusCode).toBe(200);
    expect(queryRelation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        parentIds: ['quoted-42'],
        orderBy: { column: 'position', direction: 'asc' },
      }),
    );
    expect(queryRelation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        parentIds: ['quoted-42'],
        orderBy: { column: 'position', direction: 'asc' },
      }),
    );

    await app.close();
  });

  it('loads and maps relations using their configured parent reference columns', async () => {
    const relationConfig: InventoryResourceConfig = {
      ...testConfig,
      relations: {
        images: {
          table: 'Image',
          foreignKey: 'productSlug',
          referenceKey: '"slug"',
          fields: { url: 'url' },
          imageUrlField: 'url',
        },
      },
    };
    const row = {
      id: '42',
      slug: 'test-item',
      name: 'Test Item',
      price: 99.99,
      updatedAt: '2026-02-01T00:00:00Z',
    };
    const queryRelation = vi
      .fn()
      .mockResolvedValue(new Map([['test-item', [{ url: 'https://example.com/image.jpg' }]]]));
    const query = vi.fn().mockResolvedValue({ rows: [row], total: 1 });
    const queryById = vi.fn().mockResolvedValue(row);
    const app = Fastify();
    registerInventoryRoutes(app, {
      dbAdapter: createMockDbAdapter({ query, queryById, queryRelation }),
      resourceConfig: relationConfig,
    });

    const listResponse = await app.inject({ method: 'GET', url: '/inventory' });
    const itemResponse = await app.inject({ method: 'GET', url: '/inventory/42' });

    expect(query).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
      expect.arrayContaining(['"slug"']),
    );
    expect(queryById).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
      expect.arrayContaining(['"slug"']),
    );
    expect(queryRelation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ parentIds: ['test-item'] }),
    );
    expect(queryRelation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ parentIds: ['test-item'] }),
    );
    expect(listResponse.json().items[0].images).toEqual(['https://example.com/image.jpg']);
    expect(itemResponse.json().images).toEqual(['https://example.com/image.jpg']);

    await app.close();
  });
});

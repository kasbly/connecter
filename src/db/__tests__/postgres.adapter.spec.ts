import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseConfig } from '../../config/config.types.js';
import {
  PostgresAdapter,
  isSafeOrderByColumn,
  buildOrderByClause,
  resolveCountLimit,
  DEFAULT_COUNT_LIMIT,
} from '../postgres.adapter.js';
import type { QueryCondition, SortOptions } from '../adapter.interface.js';

const { knexMock, rawMock } = vi.hoisted(() => {
  const rawMock = vi.fn().mockResolvedValue(undefined);
  const knexMock = vi.fn(() => ({
    raw: rawMock,
    destroy: vi.fn().mockResolvedValue(undefined),
  }));
  return { knexMock, rawMock };
});

vi.mock('knex', () => ({ default: knexMock }));

function createDatabaseConfig(overrides: Partial<DatabaseConfig> = {}): DatabaseConfig {
  return {
    type: 'postgres',
    host: 'database.internal',
    port: 5432,
    database: 'inventory',
    user: 'connector',
    password: 'password',
    ssl: true,
    statementTimeoutMs: 10_000,
    pool: { min: 0, max: 5 },
    ...overrides,
  };
}

describe('PostgresAdapter TLS configuration', () => {
  beforeEach(() => {
    knexMock.mockClear();
    rawMock.mockClear();
  });

  it('verifies the server certificate by default when SSL is enabled', async () => {
    await new PostgresAdapter(createDatabaseConfig()).connect();

    expect(knexMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({
          ssl: { rejectUnauthorized: true },
        }),
      }),
    );
  });

  it('passes a configured CA bundle to Postgres while keeping verification enabled', async () => {
    const sslCa = '-----BEGIN CERTIFICATE-----\nprivate-ca\n-----END CERTIFICATE-----';

    await new PostgresAdapter(createDatabaseConfig({ sslCa })).connect();

    expect(knexMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({
          ssl: { rejectUnauthorized: true, ca: sslCa },
        }),
      }),
    );
  });

  it('allows certificate verification to be disabled only through the explicit escape hatch', async () => {
    await new PostgresAdapter(createDatabaseConfig({ sslRejectUnauthorized: false })).connect();

    expect(knexMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({
          ssl: { rejectUnauthorized: false },
        }),
      }),
    );
  });

  it('does not configure TLS when SSL is disabled', async () => {
    await new PostgresAdapter(
      createDatabaseConfig({
        ssl: false,
        sslCa: 'ignored-ca',
        sslRejectUnauthorized: false,
      }),
    ).connect();

    expect(knexMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connection: expect.objectContaining({ ssl: false }),
      }),
    );
  });
});

describe('PostgresAdapter pool configuration', () => {
  beforeEach(() => {
    knexMock.mockClear();
    rawMock.mockClear();
  });

  it('honours the configured pool bounds when connecting', async () => {
    await new PostgresAdapter(createDatabaseConfig({ pool: { min: 1, max: 2 } })).connect();

    expect(knexMock).toHaveBeenCalledWith(
      expect.objectContaining({ pool: expect.objectContaining({ min: 1, max: 2 }) }),
    );
    expect(rawMock).toHaveBeenCalledTimes(1);
  });
});

describe('PostgresAdapter relation probes', () => {
  beforeEach(() => {
    knexMock.mockClear();
    rawMock.mockClear();
  });

  it('validates relation expressions even when the parent resource has no rows', async () => {
    const adapter = new PostgresAdapter(createDatabaseConfig());
    await adapter.connect();
    rawMock.mockClear();

    await adapter.queryRelation({
      table: 'images',
      foreignKey: 'inventory_id',
      parentIds: [],
      fields: { url: 'url' },
      filter: 'published = true',
      orderBy: { column: 'position', direction: 'asc' },
    });

    expect(rawMock).toHaveBeenCalledWith(
      'SELECT url as "url", inventory_id as "__fk" FROM "public"."images" WHERE FALSE AND (published = true) ORDER BY position ASC NULLS LAST',
    );
  });
});

describe('PostgresAdapter distinct status probe', () => {
  beforeEach(() => {
    knexMock.mockClear();
    rawMock.mockClear();
  });

  it('de-duplicates inside a bounded subquery instead of scanning the whole table', async () => {
    const adapter = new PostgresAdapter(createDatabaseConfig());
    await adapter.connect();
    rawMock.mockClear();
    rawMock.mockResolvedValueOnce({ rows: [{ value: 'for_sale' }, { value: 'under_offer' }] });

    const values = await adapter.distinctValues({
      table: 'cars',
      column: 'availability',
      limit: 50,
      scanLimit: 5000,
      baseFilter: 'published = true',
    });

    expect(rawMock).toHaveBeenCalledWith(
      'SELECT DISTINCT "value" FROM (SELECT availability AS "value" ' +
        'FROM "public"."cars" WHERE (published = true) LIMIT ?) AS "sampled_rows" LIMIT ?',
      [5000, 50],
    );
    expect(values).toEqual(['for_sale', 'under_offer']);
  });
});

describe('PostgresAdapter statement timeout', () => {
  beforeEach(() => {
    knexMock.mockClear();
    rawMock.mockClear();
  });

  it('sets the configured statement timeout on every new pool connection', async () => {
    await new PostgresAdapter(createDatabaseConfig({ statementTimeoutMs: 2_500 })).connect();

    type AfterCreate = (
      connection: { query: (sql: string, callback: (error: unknown) => void) => void },
      done: (error: unknown) => void,
    ) => void;
    const knexConfig = Reflect.get(knexMock.mock.calls[0] ?? [], 0) as {
      pool: { afterCreate: AfterCreate };
    };
    const query = vi.fn((_sql: string, callback: (error: unknown) => void) => callback(null));
    const done = vi.fn();

    knexConfig.pool.afterCreate({ query }, done);

    expect(query).toHaveBeenNthCalledWith(
      1,
      'SET default_transaction_read_only = ON',
      expect.any(Function),
    );
    expect(query).toHaveBeenNthCalledWith(2, 'SET statement_timeout = 2500', done);
    expect(done).toHaveBeenCalledWith(null);
  });
});

describe('PostgresAdapter pool configuration', () => {
  beforeEach(() => {
    knexMock.mockClear();
    rawMock.mockClear();
  });

  it('honors configured pool bounds without raising them', async () => {
    await new PostgresAdapter(createDatabaseConfig({ pool: { min: 1, max: 2 } })).connect();

    expect(knexMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pool: expect.objectContaining({ min: 1, max: 2 }),
      }),
    );
    expect(rawMock).toHaveBeenCalledTimes(1);
  });
});

describe('isSafeOrderByColumn', () => {
  it('accepts bare identifiers', () => {
    expect(isSafeOrderByColumn('price')).toBe(true);
    expect(isSafeOrderByColumn('updatedAt')).toBe(true);
    expect(isSafeOrderByColumn('id')).toBe(true);
    expect(isSafeOrderByColumn('_id')).toBe(true);
  });

  it('accepts a single double-quoted identifier', () => {
    expect(isSafeOrderByColumn('"makeEn"')).toBe(true);
    expect(isSafeOrderByColumn('"fuelType"')).toBe(true);
  });

  it.each([
    ['empty string', ''],
    [
      'CASE-based boolean/error-based injection',
      '(CASE WHEN (SELECT 1)=1 THEN price ELSE 1/0 END)',
    ],
    ['stacked query', 'price; DROP TABLE "Car"; --'],
    ['subquery via comma', 'price, (SELECT pg_sleep(5))'],
    ['bare subquery', '(SELECT pg_sleep(5))'],
    ['quote-breakout', "price' OR '1'='1"],
    ['block-comment obfuscation', 'price/**/OR/**/1=1'],
    ['trailing statement', 'price ASC; SELECT pg_sleep(5)'],
    ['leading digit', '1=1'],
    ['whitespace inside identifier', 'price updatedAt'],
    ['unterminated quote', '"price'],
    ['nested quotes with content', '"price" OR "1"="1"'],
  ])('rejects %s (%j)', (_label, payload) => {
    expect(isSafeOrderByColumn(payload)).toBe(false);
  });
});

describe('buildOrderByClause', () => {
  it('builds an ORDER BY fragment for a safe ascending column', () => {
    const sort: SortOptions = { column: 'price', direction: 'asc' };
    expect(buildOrderByClause(sort)).toBe('price ASC NULLS LAST');
  });

  it('builds an ORDER BY fragment for a safe descending quoted column', () => {
    const sort: SortOptions = { column: '"makeEn"', direction: 'desc' };
    expect(buildOrderByClause(sort)).toBe('"makeEn" DESC NULLS LAST');
  });

  it('treats any direction other than asc as desc, matching the pre-existing contract', () => {
    const sort = { column: 'price', direction: 'sideways' } as unknown as SortOptions;
    expect(buildOrderByClause(sort)).toBe('price DESC NULLS LAST');
  });

  it('throws instead of interpolating an unsafe column expression into raw SQL', () => {
    const sort: SortOptions = {
      column: '(CASE WHEN (SELECT 1)=1 THEN price ELSE 1/0 END)',
      direction: 'asc',
    };
    expect(() => buildOrderByClause(sort)).toThrow(/unsafe column expression/);
  });

  it('throws for a stacked-query payload rather than ever returning a clause containing it', () => {
    const sort: SortOptions = { column: 'price; DROP TABLE "Car"; --', direction: 'asc' };
    expect(() => buildOrderByClause(sort)).toThrow();
  });

  it('appends the tiebreaker so tied rows keep one order across paged requests (#24914)', () => {
    const sort: SortOptions = { column: 'updatedAt', direction: 'desc', tiebreaker: 'id' };
    expect(buildOrderByClause(sort)).toBe('updatedAt DESC NULLS LAST, id DESC');
  });

  it('appends the tiebreaker to an ascending sort too', () => {
    const sort: SortOptions = { column: 'price', direction: 'asc', tiebreaker: '"id"' };
    expect(buildOrderByClause(sort)).toBe('price ASC NULLS LAST, "id" DESC');
  });

  it('omits the tiebreaker when it is the sort column, which is already unique', () => {
    const sort: SortOptions = { column: 'id', direction: 'desc', tiebreaker: 'id' };
    expect(buildOrderByClause(sort)).toBe('id DESC NULLS LAST');
  });

  it('throws instead of interpolating an unsafe tiebreaker into raw SQL', () => {
    const sort: SortOptions = {
      column: 'updatedAt',
      direction: 'desc',
      tiebreaker: 'id; DROP TABLE "Car"; --',
    };
    expect(() => buildOrderByClause(sort)).toThrow(/unsafe column expression/);
  });
});

describe('PostgresAdapter relation ordering', () => {
  beforeEach(() => {
    rawMock.mockClear();
    rawMock.mockResolvedValue({ rows: [] });
  });

  function createAdapterForRelationQuery() {
    const adapter = new PostgresAdapter(createDatabaseConfig());
    (adapter as unknown as { db: { raw: typeof rawMock } }).db = { raw: rawMock };
    return adapter;
  }

  it('uses the configured safe relation order', async () => {
    const adapter = createAdapterForRelationQuery();

    await adapter.queryRelation({
      table: 'Image',
      foreignKey: 'carId',
      parentIds: ['car-1'],
      fields: { url: 'url' },
      orderBy: { column: 'position', direction: 'asc' },
    });

    expect(rawMock).toHaveBeenCalledWith(
      'SELECT url as "url", carId as "__fk" FROM "public"."Image" WHERE carId IN (?) ORDER BY position ASC NULLS LAST',
      ['car-1'],
    );
  });

  it('qualifies relation reads with the configured schema and table separately', async () => {
    const adapter = createAdapterForRelationQuery();

    await adapter.queryRelation({
      schema: 'catalog',
      table: 'product_images',
      foreignKey: 'product_id',
      parentIds: ['product-1'],
      fields: { url: 'url' },
    });

    expect(rawMock).toHaveBeenCalledWith(
      'SELECT url as "url", product_id as "__fk" FROM "catalog"."product_images" WHERE product_id IN (?) ORDER BY product_id ASC NULLS LAST, url ASC NULLS LAST',
      ['product-1'],
    );
  });

  it('falls back to the foreign key and first field for deterministic relation order', async () => {
    const adapter = createAdapterForRelationQuery();

    await adapter.queryRelation({
      table: 'Image',
      foreignKey: 'carId',
      parentIds: ['car-1'],
      fields: { url: 'url' },
    });

    expect(rawMock).toHaveBeenCalledWith(
      'SELECT url as "url", carId as "__fk" FROM "public"."Image" WHERE carId IN (?) ORDER BY carId ASC NULLS LAST, url ASC NULLS LAST',
      ['car-1'],
    );
  });

  it('refuses unsafe configured relation ordering', async () => {
    const adapter = createAdapterForRelationQuery();

    await expect(
      adapter.queryRelation({
        table: 'Image',
        foreignKey: 'carId',
        parentIds: ['car-1'],
        fields: { url: 'url' },
        orderBy: { column: 'position; DROP TABLE "Image"', direction: 'asc' },
      }),
    ).rejects.toThrow(/unsafe column expression/);
    expect(rawMock).not.toHaveBeenCalled();
  });
});

describe('resolveCountLimit', () => {
  it('caps the first page at the default limit', () => {
    expect(resolveCountLimit({ page: 1, pageSize: 20 })).toBe(DEFAULT_COUNT_LIMIT);
    expect(resolveCountLimit({ page: 5, pageSize: 100 })).toBe(DEFAULT_COUNT_LIMIT);
  });

  it('never counts fewer rows than the requested page needs, plus one', () => {
    // offset 4000 + pageSize 20 => the page itself ends at row 4020, so the cap
    // must reach 4021 for `totalPages` to still advertise a further page.
    expect(resolveCountLimit({ page: 201, pageSize: 20 })).toBe(4021);
  });

  it('honours an explicit cap override', () => {
    expect(resolveCountLimit({ page: 1, pageSize: 20 }, 50)).toBe(50);
    expect(resolveCountLimit({ page: 1, pageSize: 20 }, 5)).toBe(21);
  });
});

const { default: realKnex } = await vi.importActual<typeof import('knex')>('knex');

interface CompiledQuery {
  sql: string;
  bindings: readonly unknown[];
  method: string;
}

/**
 * A real Knex `pg` instance whose execution layer is replaced, so specs assert
 * on the SQL the adapter actually compiles instead of on a hand-rolled builder
 * mock that could not tell an exact COUNT(*) from a bounded one.
 */
function createRecordingKnex(options: { dataRows: Record<string, unknown>[]; count: number }) {
  const captured: CompiledQuery[] = [];
  const db = realKnex({ client: 'pg' });
  const client = db.client as unknown as {
    runner: (builder: { toSQL: () => CompiledQuery }) => { run: () => Promise<unknown> };
  };

  client.runner = (builder) => ({
    run: async () => {
      const compiled = builder.toSQL();
      captured.push(compiled);
      const rows: Record<string, unknown>[] = compiled.sql.includes('count(*)')
        ? [{ count: String(options.count) }]
        : options.dataRows;
      return compiled.method === 'first' ? rows[0] : rows;
    },
  });

  return { db, captured };
}

async function runListQuery(options: {
  dataRows?: Record<string, unknown>[];
  count: number;
  conditions?: QueryCondition[];
  page?: number;
  pageSize?: number;
  baseFilter?: string;
  schema?: string;
  sort?: SortOptions;
}) {
  const { db, captured } = createRecordingKnex({
    dataRows: options.dataRows ?? [],
    count: options.count,
  });
  knexMock.mockReturnValueOnce(db as unknown as ReturnType<typeof knexMock>);

  const adapter = new PostgresAdapter(createDatabaseConfig());
  await adapter.connect();
  captured.length = 0; // drop the pool warm-up `SELECT 1`s

  const result = await adapter.query(
    'Car',
    options.conditions ?? [],
    { page: options.page ?? 1, pageSize: options.pageSize ?? 20 },
    options.sort ?? { column: 'price', direction: 'asc' },
    options.baseFilter ?? 'published = true',
    ['id', 'price'],
    options.schema,
  );

  const countQuery = captured.find((query) => query.sql.includes('count(*)'));
  const dataQuery = captured.find((query) => !query.sql.includes('count(*)'));
  if (!countQuery || !dataQuery) {
    throw new Error(`Expected a count and a data query, got: ${JSON.stringify(captured)}`);
  }

  return { result, countQuery, dataQuery };
}

async function runQueryById(options: {
  dataRows?: Record<string, unknown>[];
  id?: string;
  baseFilter?: string;
  schema?: string;
}) {
  const { db, captured } = createRecordingKnex({
    dataRows: options.dataRows ?? [],
    count: 0,
  });
  knexMock.mockReturnValueOnce(db as unknown as ReturnType<typeof knexMock>);

  const adapter = new PostgresAdapter(createDatabaseConfig());
  await adapter.connect();
  captured.length = 0; // drop the pool warm-up `SELECT 1`s

  await adapter.queryById(
    'Car',
    'id',
    options.id ?? '123',
    options.baseFilter ?? 'published = true',
    undefined,
    options.schema,
  );

  const query = captured[0];
  if (!query) {
    throw new Error('Expected an ID query to be captured');
  }

  return query;
}

describe('PostgresAdapter list count (#17420)', () => {
  beforeEach(() => {
    knexMock.mockClear();
    rawMock.mockClear();
  });

  it('counts through a LIMITed subquery instead of scanning every matching row', async () => {
    const { countQuery } = await runListQuery({ count: 20 });

    expect(countQuery.sql).toBe(
      'select count(*) as "count" from (select 1 from "public"."Car" where (published = true) limit ?) as "bounded_count" limit ?',
    );
    expect(countQuery.bindings).toContain(DEFAULT_COUNT_LIMIT);
    // The pre-#17420 shape: an unbounded exact count over the merchant table.
    expect(countQuery.sql).not.toBe(
      'select count(*) as "count" from "Car" where (published = true)',
    );
  });

  it('qualifies list and item reads with the configured schema', async () => {
    const { dataQuery } = await runListQuery({ count: 1, schema: 'catalog' });
    const itemQuery = await runQueryById({ schema: 'catalog' });

    expect(dataQuery.sql).toContain('from "catalog"."Car"');
    expect(itemQuery.sql).toContain('from "catalog"."Car"');
  });

  it('still applies the same filter and ILIKE search predicates to the bounded count', async () => {
    const conditions: QueryCondition[] = [
      { column: 'year', operator: '=', value: 2024 },
      { column: 'title', operator: 'ILIKE', value: 'sonata', _group: 'sonata' },
      { column: '"makeEn"', operator: 'ILIKE', value: 'sonata', _group: 'sonata' },
    ];

    const { countQuery, dataQuery } = await runListQuery({ count: 3, conditions });

    expect(countQuery.sql).toContain('where (published = true) and year = ?');
    expect(countQuery.sql).toContain(`(title ILIKE ? ESCAPE '\\' or "makeEn" ILIKE ? ESCAPE '\\')`);
    expect(countQuery.bindings).toEqual([2024, '%sonata%', '%sonata%', DEFAULT_COUNT_LIMIT, 1]);
    // Same predicates as the data query — the count must not silently widen or
    // narrow the result set it reports on.
    expect(dataQuery.bindings.slice(0, 3)).toEqual([2024, '%sonata%', '%sonata%']);
  });

  it('applies IN filters with their bindings to both data and bounded count queries', async () => {
    const conditions: QueryCondition[] = [
      { column: 'availability', operator: 'IN', value: ['sold', 'closed'] },
      { column: 'year', operator: '=', value: 2024 },
      { column: 'title', operator: 'ILIKE', value: 'sonata', _group: 'sonata' },
      { column: '"makeEn"', operator: 'ILIKE', value: 'sonata', _group: 'sonata' },
    ];

    const { countQuery, dataQuery } = await runListQuery({ count: 3, conditions });

    expect(countQuery.sql).toContain('availability IN (?, ?)');
    expect(dataQuery.sql).toContain('availability IN (?, ?)');
    expect(countQuery.bindings.slice(0, 2)).toEqual(['sold', 'closed']);
    expect(dataQuery.bindings.slice(0, 2)).toEqual(['sold', 'closed']);
  });

  it('escapes LIKE metacharacters in search values for data and count queries', async () => {
    const conditions: QueryCondition[] = [
      { column: 'title', operator: 'ILIKE', value: String.raw`50%_off\sale`, _group: 'term' },
    ];

    const { countQuery, dataQuery } = await runListQuery({ count: 1, conditions });

    expect(countQuery.sql).toContain(`title ILIKE ? ESCAPE '\\'`);
    expect(dataQuery.sql).toContain(`title ILIKE ? ESCAPE '\\'`);
    expect(countQuery.bindings[0]).toBe(String.raw`%50\%\_off\\sale%`);
    expect(dataQuery.bindings[0]).toBe(String.raw`%50\%\_off\\sale%`);
  });

  it('reports an exact, uncapped total when the result set is below the cap', async () => {
    const { result } = await runListQuery({
      count: 7,
      dataRows: [{ id: '1', price: 10 }],
    });

    expect(result.total).toBe(7);
    expect(result.totalIsCapped).toBe(false);
    expect(result.rows).toEqual([{ id: '1', price: 10 }]);
  });

  it('flags the total as a lower bound once the count reaches the cap', async () => {
    const { result } = await runListQuery({ count: DEFAULT_COUNT_LIMIT });

    expect(result.total).toBe(DEFAULT_COUNT_LIMIT);
    expect(result.totalIsCapped).toBe(true);
  });

  it('lifts the cap for a deep page so the page being served is never hidden by it', async () => {
    const { countQuery, result } = await runListQuery({
      count: 4021,
      page: 201,
      pageSize: 20,
    });

    expect(countQuery.bindings).toContain(4021);
    // total 4021 over pageSize 20 => 202 pages, i.e. page 201 is not reported
    // as the last page while more rows exist.
    expect(Math.ceil(result.total / 20)).toBeGreaterThan(201);
  });

  it('orders the page by the tiebreaker as well, so OFFSET slices a total order (#24914)', async () => {
    const { dataQuery } = await runListQuery({
      count: 40,
      page: 2,
      sort: { column: 'updatedAt', direction: 'desc', tiebreaker: 'id' },
    });

    expect(dataQuery.sql).toContain('order by updatedAt DESC NULLS LAST, id DESC');
    expect(dataQuery.sql).toContain('limit ?');
    expect(dataQuery.sql).toContain('offset ?');
  });
});

describe('PostgresAdapter base filters', () => {
  beforeEach(() => {
    knexMock.mockClear();
    rawMock.mockClear();
  });

  it('groups an OR base filter with list and count predicates', async () => {
    const { countQuery, dataQuery } = await runListQuery({
      count: 1,
      conditions: [{ column: 'year', operator: '=', value: 2024 }],
      baseFilter: "status = 'ACTIVE' OR status = 'RESERVED'",
    });

    expect(dataQuery.sql).toContain(
      "where (status = 'ACTIVE' OR status = 'RESERVED') and year = ?",
    );
    expect(countQuery.sql).toContain(
      "where (status = 'ACTIVE' OR status = 'RESERVED') and year = ?",
    );
  });

  it('groups an OR base filter with the requested ID', async () => {
    const query = await runQueryById({
      baseFilter: "status = 'ACTIVE' OR status = 'RESERVED'",
    });

    expect(query.sql).toBe(
      'select * from "public"."Car" where id = ? and (status = \'ACTIVE\' OR status = \'RESERVED\') limit ?',
    );
    expect(query.bindings).toEqual(['123', 1]);
  });
});

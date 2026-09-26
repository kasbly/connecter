import { beforeEach, describe, expect, it, vi } from 'vitest';

const { knexMock } = vi.hoisted(() => ({ knexMock: vi.fn() }));

vi.mock('knex', () => ({ default: knexMock }));

import {
  createDatabaseConnectionOptions,
  introspectDatabase,
  isTlsRequiredError,
  SETUP_STATEMENT_TIMEOUT_MS,
  type DbConnectOptions,
} from '../introspect.js';

const connection: DbConnectOptions = {
  type: 'postgres',
  host: 'database.example.com',
  port: 5432,
  database: 'inventory',
  user: 'connector',
  password: 'secret',
  ssl: false,
};

describe('createDatabaseConnectionOptions', () => {
  it('matches the connector TLS configuration including a private CA', () => {
    expect(
      createDatabaseConnectionOptions({
        ...connection,
        ssl: true,
        sslCa: 'private-ca',
        sslRejectUnauthorized: false,
      }),
    ).toMatchObject({
      host: connection.host,
      ssl: { ca: 'private-ca', rejectUnauthorized: false },
    });
  });
});

describe('isTlsRequiredError', () => {
  it.each([
    'no pg_hba.conf entry for host "10.0.0.1", user "connector", database "inventory", no encryption',
    'connection is insecure (try using sslmode=require)',
  ])('recognizes a PostgreSQL TLS requirement: %s', (message) => {
    expect(isTlsRequiredError(new Error(message))).toBe(true);
  });
});

describe('introspectDatabase', () => {
  beforeEach(() => {
    knexMock.mockReset();
  });

  it('retries a rejected plaintext probe with verified TLS', async () => {
    const plaintextDb = {
      raw: vi
        .fn()
        .mockRejectedValue(new Error('connection is insecure (try using sslmode=require)')),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    const tlsDb = {
      raw: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    knexMock.mockReturnValueOnce(plaintextDb).mockReturnValueOnce(tlsDb);

    const result = await introspectDatabase(connection);

    expect(plaintextDb.destroy).toHaveBeenCalledOnce();
    expect(knexMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        connection: expect.objectContaining({ ssl: { rejectUnauthorized: true } }),
      }),
    );
    expect(result.retriedWithTls).toBe(true);
  });

  it('uses a read-only PostgreSQL pool with a statement timeout', async () => {
    const db = {
      raw: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    knexMock.mockReturnValueOnce(db);

    await introspectDatabase(connection);

    const knexOptions = knexMock.mock.calls[0]![0] as {
      pool: {
        afterCreate: (
          conn: { query: (sql: string, cb: (error: unknown) => void) => void },
          done: (error: unknown) => void,
        ) => void;
      };
    };
    const query = vi.fn((_sql: string, callback: (error: unknown) => void) => callback(null));
    const done = vi.fn();
    knexOptions.pool.afterCreate({ query }, done);

    expect(query).toHaveBeenNthCalledWith(
      1,
      'SET default_transaction_read_only = ON',
      expect.any(Function),
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      `SET statement_timeout = ${SETUP_STATEMENT_TIMEOUT_MS}`,
      done,
    );
  });

  it('introspects tables, keys, and relations in the selected schema', async () => {
    const db = {
      raw: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [{ name: 'products', kind: 'table' }] })
        .mockResolvedValueOnce({
          rows: [
            { column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO' },
            { column_name: 'title', data_type: 'text', udt_name: 'text', is_nullable: 'NO' },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ column_name: 'id' }] })
        .mockResolvedValueOnce({ rows: [{ estimate: '12' }] })
        .mockResolvedValueOnce({
          rows: [
            {
              constraint_name: 'images_product_id_fkey',
              from_table: 'images',
              from_column: 'product_id',
              to_table: 'products',
              to_column: 'id',
            },
          ],
        }),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    knexMock.mockReturnValueOnce(db);

    const result = await introspectDatabase({ ...connection, schema: 'catalog' });

    expect(knexMock).toHaveBeenCalledWith(expect.objectContaining({ searchPath: ['catalog'] }));
    expect(db.raw).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FROM information_schema.tables'),
      ['catalog', 'catalog'],
    );
    expect(db.raw).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('WHERE table_name = ? AND table_schema = ?'),
      ['products', 'catalog'],
    );
    expect(db.raw).toHaveBeenNthCalledWith(6, expect.stringContaining('FROM pg_constraint c'), [
      'catalog',
    ]);
    expect(result.result).toEqual({
      tables: [
        {
          name: 'products',
          kind: 'table',
          rowCount: 12,
          columns: [
            { name: 'id', type: 'uuid', udtName: 'uuid', nullable: false, isPrimaryKey: true },
            { name: 'title', type: 'text', udtName: 'text', nullable: false, isPrimaryKey: false },
          ],
        },
      ],
      foreignKeys: [
        {
          constraintName: 'images_product_id_fkey',
          fromTable: 'images',
          fromColumn: 'product_id',
          toTable: 'products',
          toColumn: 'id',
        },
      ],
    });
  });

  it('returns a view when it is the schema’s only inventory object', async () => {
    const db = {
      raw: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [{ name: 'published_products', kind: 'view' }] })
        .mockResolvedValueOnce({
          rows: [
            { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
            { column_name: 'title', data_type: 'text', is_nullable: 'NO' },
          ],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ estimate: '12' }] })
        .mockResolvedValueOnce({ rows: [] }),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    knexMock.mockReturnValueOnce(db);

    const result = await introspectDatabase({ ...connection, schema: 'catalog' });

    expect(db.raw).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("table_type IN ('BASE TABLE', 'VIEW')"),
      ['catalog', 'catalog'],
    );
    expect(db.raw).toHaveBeenNthCalledWith(2, expect.stringContaining('FROM pg_matviews'), [
      'catalog',
      'catalog',
    ]);
    expect(result.result).toEqual({
      tables: [
        {
          name: 'published_products',
          kind: 'view',
          rowCount: 12,
          columns: [
            { name: 'id', type: 'uuid', nullable: false, isPrimaryKey: false },
            { name: 'title', type: 'text', nullable: false, isPrimaryKey: false },
          ],
        },
      ],
      foreignKeys: [],
    });
  });

  it('reads materialized-view columns and a unique index from PostgreSQL catalogs', async () => {
    const db = {
      raw: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [{ name: 'inventory', kind: 'materialized view' }] })
        .mockResolvedValueOnce({
          rows: [
            { column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO' },
            { column_name: 'title', data_type: 'text', udt_name: 'text', is_nullable: 'NO' },
            {
              column_name: 'price',
              data_type: 'numeric',
              udt_name: 'numeric',
              is_nullable: 'NO',
            },
            {
              column_name: 'currency',
              data_type: 'character varying',
              udt_name: 'varchar',
              is_nullable: 'YES',
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ column_name: 'id' }] })
        .mockResolvedValueOnce({ rows: [{ estimate: '12000' }] })
        .mockResolvedValueOnce({ rows: [] }),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    knexMock.mockReturnValueOnce(db);

    const result = await introspectDatabase({ ...connection, schema: 'catalog' });

    expect(db.raw).toHaveBeenNthCalledWith(3, expect.stringContaining('FROM pg_attribute a'), [
      'inventory',
      'catalog',
    ]);
    // The matview branch must read types with a NULL typmod, matching the
    // bare vocabulary `information_schema.columns.data_type` uses for tables
    // and ordinary views (e.g. `character varying`, not `character varying(255)`).
    // Passing the real `a.atttypmod` here is the regression from #28745: every
    // downstream exact-match type predicate (isTextColumn, NUMERIC_TYPES,
    // isAttributeEligibleColumn, isCompatibleFieldColumn) misses a modified type.
    expect(db.raw).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('pg_catalog.format_type(a.atttypid, NULL)'),
      ['inventory', 'catalog'],
    );
    expect(db.raw).not.toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('pg_catalog.format_type(a.atttypid, a.atttypmod)'),
      ['inventory', 'catalog'],
    );
    expect(db.raw).toHaveBeenNthCalledWith(4, expect.stringContaining('FROM pg_index i'), [
      'inventory',
      'catalog',
    ]);

    // Regression guard for #28744: the outer SELECT/JOIN reads `i.indkey` (and
    // the other `i.*` columns) from the `unique_index` CTE, so every one of
    // those columns must actually be projected by the CTE's own SELECT list.
    // PostgreSQL rejects the statement at parse time otherwise ("column
    // i.indkey does not exist") — a mocked `db.raw` can never catch that, so
    // this test inspects the real SQL string instead of just its return shape.
    const pkSql = db.raw.mock.calls[3]![0] as string;
    const cteSelectMatch = pkSql.match(/unique_index AS \(\s*SELECT ([\s\S]*?)\s*FROM pg_index i/);
    expect(cteSelectMatch).not.toBeNull();
    const projectedColumns = cteSelectMatch![1]!
      .split(',')
      .map((column) => column.trim())
      .filter(Boolean);

    const outerQuery = pkSql.slice(pkSql.indexOf('SELECT a.attname'));
    const referencedColumns = [
      ...new Set([...outerQuery.matchAll(/\bi\.(\w+)/g)].map((m) => `i.${m[1]}`)),
    ];
    expect(referencedColumns).toEqual(
      expect.arrayContaining(['i.indkey', 'i.indrelid', 'i.indnkeyatts']),
    );
    for (const column of referencedColumns) {
      expect(projectedColumns).toContain(column);
    }

    expect(result.result).toEqual({
      tables: [
        {
          name: 'inventory',
          kind: 'materialized view',
          rowCount: 12000,
          columns: [
            { name: 'id', type: 'uuid', udtName: 'uuid', nullable: false, isPrimaryKey: true },
            {
              name: 'title',
              type: 'text',
              udtName: 'text',
              nullable: false,
              isPrimaryKey: false,
            },
            {
              name: 'price',
              type: 'numeric',
              udtName: 'numeric',
              nullable: false,
              isPrimaryKey: false,
            },
            {
              name: 'currency',
              type: 'character varying',
              udtName: 'varchar',
              nullable: true,
              isPrimaryKey: false,
            },
          ],
        },
      ],
      foreignKeys: [],
    });
    // Bare type names, as `information_schema` reports them and as
    // `pg_catalog.format_type(a.atttypid, NULL)` now produces — no `(255)`,
    // `(10,2)`, or other type-modifier suffix leaking through.
    for (const column of result.result.tables[0]!.columns) {
      expect(column.type).not.toMatch(/\(/);
    }
  });
});

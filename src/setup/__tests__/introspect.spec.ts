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
        .mockResolvedValueOnce({ rows: [{ tablename: 'products' }] })
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
      'SELECT tablename FROM pg_tables WHERE schemaname = ? ORDER BY tablename',
      ['catalog'],
    );
    expect(db.raw).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('WHERE table_name = ? AND table_schema = ?'),
      ['products', 'catalog'],
    );
    expect(db.raw).toHaveBeenNthCalledWith(6, expect.stringContaining('tc.table_schema = ?'), [
      'catalog',
    ]);
    expect(result.result).toEqual({
      tables: [
        {
          name: 'products',
          rowCount: 12,
          columns: [
            { name: 'id', type: 'uuid', udtName: 'uuid', nullable: false, isPrimaryKey: true },
            { name: 'title', type: 'text', udtName: 'text', nullable: false, isPrimaryKey: false },
          ],
        },
      ],
      foreignKeys: [
        { fromTable: 'images', fromColumn: 'product_id', toTable: 'products', toColumn: 'id' },
      ],
    });
  });
});

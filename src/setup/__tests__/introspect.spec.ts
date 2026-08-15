import { beforeEach, describe, expect, it, vi } from 'vitest';

const { knexMock } = vi.hoisted(() => ({ knexMock: vi.fn() }));

vi.mock('knex', () => ({ default: knexMock }));

import {
  createDatabaseConnectionOptions,
  introspectDatabase,
  isTlsRequiredError,
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
});

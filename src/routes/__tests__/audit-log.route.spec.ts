import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  encodeAuditContinuation,
  parseAuditContinuation,
  type AuditService,
} from '../../audit/audit.service.js';
import { registerAuditLogRoute } from '../audit-log.route.js';

function createAuditService(): AuditService {
  return {
    query: vi.fn().mockResolvedValue({
      entries: [],
      total: 0,
      totalIsCapped: false,
      continuation: null,
    }),
  } as unknown as AuditService;
}

describe('audit log route', () => {
  it('rejects a non-ISO since value before querying the audit log', async () => {
    const auditService = createAuditService();
    const app = Fastify();
    registerAuditLogRoute(app, auditService);

    const response = await app.inject({ method: 'GET', url: '/audit-log?since=2026/08/12' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      message: 'Query parameter "since" must be a valid date or timestamp',
    });
    expect(auditService.query).not.toHaveBeenCalled();
    await app.close();
  });

  it('normalizes offset-form since values before querying the audit log', async () => {
    const auditService = createAuditService();
    const app = Fastify();
    registerAuditLogRoute(app, auditService);

    const response = await app.inject({
      method: 'GET',
      url: '/audit-log?since=2026-08-12T13:00:00%2B03:00',
    });

    expect(response.statusCode).toBe(200);
    expect(auditService.query).toHaveBeenCalledWith({
      page: 1,
      pageSize: 50,
      since: '2026-08-12T10:00:00.000Z',
      continuation: undefined,
    });
    await app.close();
  });

  it('accepts a page within the maximum offset', async () => {
    const auditService = createAuditService();
    const app = Fastify();
    registerAuditLogRoute(app, auditService);

    const response = await app.inject({ method: 'GET', url: '/audit-log?page=1001&pageSize=100' });

    expect(response.statusCode).toBe(200);
    expect(auditService.query).toHaveBeenCalledWith({
      page: 1001,
      pageSize: 100,
      since: undefined,
      continuation: undefined,
    });
    await app.close();
  });

  it('rejects a page that exceeds the maximum offset before querying the audit log', async () => {
    const auditService = createAuditService();
    const app = Fastify();
    registerAuditLogRoute(app, auditService);

    const response = await app.inject({ method: 'GET', url: '/audit-log?page=1002&pageSize=100' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      message: 'Query parameter "page" must not exceed an offset of 100000 rows',
    });
    expect(auditService.query).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects pages whose offset would exceed the audit scan limit', async () => {
    const auditService = createAuditService();
    const app = Fastify();
    registerAuditLogRoute(app, auditService);

    const response = await app.inject({ method: 'GET', url: '/audit-log?page=2002' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      message: 'Query parameter "page" must not exceed an offset of 100000 rows',
    });
    expect(auditService.query).not.toHaveBeenCalled();
    await app.close();
  });

  it('passes a continuation cursor and ignores page offset', async () => {
    const auditService = createAuditService();
    const app = Fastify();
    registerAuditLogRoute(app, auditService);
    const continuation = encodeAuditContinuation({
      ts: '2026-01-01T00:00:00.000Z',
      method: 'GET',
      path: '/inventory',
      query: {},
      apiKey: 'test',
      status: 200,
      items: 1,
      ms: 1,
      ip: '127.0.0.1',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/audit-log?page=3&pageSize=1&continuation=${continuation}`,
    });

    expect(response.statusCode).toBe(200);
    expect(auditService.query).toHaveBeenCalledWith({
      page: 1,
      pageSize: 1,
      since: undefined,
      continuation: parseAuditContinuation(continuation),
    });
    await app.close();
  });

  it('rejects an invalid continuation before querying the audit log', async () => {
    const auditService = createAuditService();
    const app = Fastify();
    registerAuditLogRoute(app, auditService);

    const response = await app.inject({
      method: 'GET',
      url: '/audit-log?continuation=not-a-cursor',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      message: 'Query parameter "continuation" must be a valid audit-log cursor',
    });
    expect(auditService.query).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns the service continuation in the response body', async () => {
    const auditService = {
      query: vi.fn().mockResolvedValue({
        entries: [],
        total: 0,
        totalIsCapped: false,
        continuation: 'next-page-token',
      }),
    } as unknown as AuditService;
    const app = Fastify();
    registerAuditLogRoute(app, auditService);

    const response = await app.inject({ method: 'GET', url: '/audit-log' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ continuation: 'next-page-token' });
    await app.close();
  });
});

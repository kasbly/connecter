import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../../audit/audit.service.js';
import { registerAuditLogRoute } from '../audit-log.route.js';

function createAuditService(): AuditService {
  return {
    query: vi.fn().mockResolvedValue({ entries: [], total: 0, totalIsCapped: false }),
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
    });
    await app.close();
  });

  it('does not cap the requested page number', async () => {
    const auditService = createAuditService();
    const app = Fastify();
    registerAuditLogRoute(app, auditService);

    const response = await app.inject({ method: 'GET', url: '/audit-log?page=11' });

    expect(response.statusCode).toBe(200);
    expect(auditService.query).toHaveBeenCalledWith({ page: 11, pageSize: 50, since: undefined });
    await app.close();
  });
});

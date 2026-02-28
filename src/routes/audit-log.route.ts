import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuditService } from '../audit/audit.service.js';

export function registerAuditLogRoute(
  app: FastifyInstance,
  auditService: AuditService,
): void {
  app.get('/audit-log', async (request: FastifyRequest) => {
    const params = request.query as {
      page?: string;
      pageSize?: string;
      since?: string;
    };

    const page = Math.max(1, parseInt(params.page ?? '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(params.pageSize ?? '50', 10) || 50));

    const { entries, total } = auditService.query({
      page,
      pageSize,
      since: params.since,
    });

    return {
      entries,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  });
}

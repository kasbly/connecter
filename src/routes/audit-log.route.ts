import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuditService } from '../audit/audit.service.js';
import { QueryValidationError } from '../mapping/query-builder.js';

const ISO_DATE_OR_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

export function registerAuditLogRoute(app: FastifyInstance, auditService: AuditService): void {
  app.get(
    '/audit-log',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request: FastifyRequest) => {
      const params = request.query as {
        page?: string;
        pageSize?: string;
        since?: string;
      };

      const page = Math.max(1, parseInt(params.page ?? '1', 10) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(params.pageSize ?? '50', 10) || 50));
      let since: string | undefined;
      if (params.since !== undefined && params.since !== '') {
        const parsed = Date.parse(params.since);
        if (!ISO_DATE_OR_TIMESTAMP.test(params.since) || Number.isNaN(parsed)) {
          throw new QueryValidationError(
            'Query parameter "since" must be a valid date or timestamp',
          );
        }
        since = new Date(parsed).toISOString();
      }

      const { entries, total, totalIsCapped } = await auditService.query({
        page,
        pageSize,
        since,
      });

      return {
        entries,
        total,
        totalIsCapped,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      };
    },
  );
}

import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { ConnectorConfig } from './config/config.types.js';
import type { DatabaseAdapter } from './db/adapter.interface.js';
import { createApiKeyGuard } from './auth/api-key.guard.js';
import { AuditService } from './audit/audit.service.js';
import { buildRateLimitOptions } from './middleware/rate-limiter.js';
import { registerHealthRoute } from './routes/health.route.js';
import { registerInventoryRoutes } from './routes/inventory.route.js';
import { registerAuditLogRoute } from './routes/audit-log.route.js';

export interface AppDeps {
  config: ConnectorConfig;
  dbAdapter: DatabaseAdapter;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, dbAdapter } = deps;

  const app = Fastify({
    logger: {
      level: 'info',
    },
    trustProxy: true,
  });

  // Rate limiting
  await app.register(rateLimit, buildRateLimitOptions(config.rateLimit));

  // API key auth (skip /health)
  app.addHook('onRequest', createApiKeyGuard(config.auth));

  // Global error handler — never expose SQL or stack traces
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    app.log.error({ err: error }, 'Request error');

    void reply.code(statusCode).send({
      error: statusCode >= 500 ? 'Internal server error' : error.message,
    });
  });

  // Audit service
  const auditService = new AuditService(config.audit);

  // Routes
  registerHealthRoute(app, dbAdapter);
  registerInventoryRoutes(app, {
    dbAdapter,
    resourceConfig: config.resources.inventory,
    auditService,
  });
  registerAuditLogRoute(app, auditService);

  return app;
}

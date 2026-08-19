import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { ConnectorConfig } from './config/config.types.js';
import type { DatabaseAdapter } from './db/adapter.interface.js';
import { createApiKeyGuard } from './auth/api-key.guard.js';
import { AuditService } from './audit/audit.service.js';
import { getClientIp } from './middleware/client-ip.js';
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

  // SECURITY: trustProxy stays false — the connector is merchant-self-hosted
  // with no guaranteed reverse proxy in front of it, so `request.ip` must
  // reflect the real socket peer, not an attacker-controlled
  // X-Forwarded-For header. Forwarded headers are honored only through
  // getClientIp(), which checks the socket peer against
  // `config.server.trustedProxies` before trusting them (see
  // middleware/client-ip.ts).
  const app = Fastify({
    logger: {
      level: 'info',
    },
    trustProxy: false,
  });

  if (!config.resources.inventory.fields['status']) {
    app.log.warn(
      'Inventory status is not mapped; every listing will be reported as ACTIVE. Map resources.inventory.fields.status to expose availability.',
    );
  }

  // Rate limiting — keyed on the trust-aware client IP, not the spoofable
  // Fastify-derived request.ip (see middleware/rate-limiter.ts).
  await app.register(
    rateLimit,
    buildRateLimitOptions(config.rateLimit, config.server.trustedProxies),
  );

  // API key auth (skip /health)
  app.addHook('onRequest', createApiKeyGuard(config.auth));

  // Global error handler — never expose SQL or stack traces
  app.setErrorHandler((error: Error & { code?: string; statusCode?: number }, _request, reply) => {
    // PostgreSQL uses SQLSTATE 57014 when statement_timeout cancels a query.
    // Treat the bounded database interruption as temporary unavailability so
    // callers can retry instead of receiving an opaque generic 500.
    const statusCode = error.code === '57014' ? 503 : (error.statusCode ?? 500);
    app.log.error({ err: error }, 'Request error');

    void reply.code(statusCode).send({
      error: statusCode >= 500 ? 'Internal server error' : error.message,
    });
  });

  // Audit service
  const auditService = new AuditService(config.audit, app.log);
  app.addHook('onResponse', async (request, reply) => {
    const auditRequest = request as FastifyRequest & {
      apiKeyLabel?: string;
      auditItems?: number;
    };

    auditService.log({
      ts: new Date().toISOString(),
      method: request.method,
      path: request.url.split('?')[0] ?? request.url,
      query: request.query as Record<string, unknown>,
      apiKey: auditRequest.apiKeyLabel ?? 'unknown',
      status: reply.statusCode,
      items: auditRequest.auditItems ?? 0,
      ms: reply.elapsedTime,
      ip: getClientIp(request, config.server.trustedProxies),
    });
  });
  app.addHook('onClose', async () => {
    await auditService.flush();
  });

  // Routes
  registerHealthRoute(app, dbAdapter, config.resources.inventory);
  registerInventoryRoutes(app, {
    dbAdapter,
    resourceConfig: config.resources.inventory,
  });
  registerAuditLogRoute(app, auditService);

  return app;
}

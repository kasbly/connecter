import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import type { AuthConfig, AuthKeyConfig } from '../config/config.types.js';

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function findMatchingKey(apiKey: string, keys: AuthKeyConfig[]): AuthKeyConfig | undefined {
  for (const keyConfig of keys) {
    if (safeCompare(apiKey, keyConfig.key)) {
      return keyConfig;
    }
  }
  return undefined;
}

/**
 * Routes the API key guard deliberately lets through unauthenticated — currently just
 * `/health`, probed by the Docker Compose healthcheck with no key. Exported so other
 * request-scoped concerns (e.g. the audit hook in server.ts) can key off the same
 * signal instead of hardcoding a second path list that could drift from this one.
 */
export function isApiKeyExempt(path: string): boolean {
  return path === '/health';
}

export function createApiKeyGuard(authConfig: AuthConfig) {
  return function apiKeyGuard(
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction,
  ): void {
    // Skip auth for health endpoint
    if (isApiKeyExempt(request.url.split('?')[0] ?? request.url)) {
      done();
      return;
    }

    const apiKey = request.headers['x-api-key'];
    if (!apiKey || typeof apiKey !== 'string') {
      void reply.code(401).send({ error: 'Missing or invalid X-API-Key header' });
      return;
    }

    const matched = findMatchingKey(apiKey, authConfig.apiKeys);
    if (!matched) {
      void reply.code(401).send({ error: 'Invalid API key' });
      return;
    }

    // Attach the key label to the request for audit logging
    (request as FastifyRequest & { apiKeyLabel?: string }).apiKeyLabel = matched.label;
    done();
  };
}

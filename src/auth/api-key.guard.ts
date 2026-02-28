import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import type { AuthConfig, AuthKeyConfig } from '../config/config.types.js';

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  return timingSafeEqual(bufA, bufB);
}

export function findMatchingKey(
  apiKey: string,
  keys: AuthKeyConfig[],
): AuthKeyConfig | undefined {
  for (const keyConfig of keys) {
    if (safeCompare(apiKey, keyConfig.key)) {
      return keyConfig;
    }
  }
  return undefined;
}

export function createApiKeyGuard(authConfig: AuthConfig) {
  return function apiKeyGuard(
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction,
  ): void {
    // Skip auth for health endpoint
    if (request.url === '/health') {
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

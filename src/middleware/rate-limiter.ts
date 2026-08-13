import type { FastifyRequest } from 'fastify';
import type { RateLimitConfig } from '../config/config.types.js';
import { getClientIp } from './client-ip.js';

export interface RateLimitOptions {
  max: number;
  timeWindow: string;
  keyGenerator: (request: FastifyRequest) => string;
}

/**
 * SECURITY: keys the limiter on `getClientIp`, which only trusts
 * X-Forwarded-For/X-Real-IP when the direct socket peer matches
 * `trustedProxies`. Without an explicit `keyGenerator`, `@fastify/rate-limit`
 * falls back to `request.ip`, which — with `trustProxy: true` — is spoofable
 * per-request via X-Forwarded-For, letting a caller bypass the limit entirely
 * by sending a fresh header value on every request.
 */
export function buildRateLimitOptions(
  config: RateLimitConfig,
  trustedProxies?: string,
): RateLimitOptions {
  return {
    max: config.maxRequests,
    timeWindow: `${config.windowSeconds} seconds`,
    keyGenerator: (request: FastifyRequest) => getClientIp(request, trustedProxies),
  };
}

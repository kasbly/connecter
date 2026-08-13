import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { buildRateLimitOptions } from '../rate-limiter.js';

function createMockRequest(overrides: {
  remoteAddress?: string;
  headers?: Record<string, string | string[] | undefined>;
}): FastifyRequest {
  return {
    socket: { remoteAddress: overrides.remoteAddress ?? '127.0.0.1' },
    headers: overrides.headers ?? {},
  } as unknown as FastifyRequest;
}

describe('buildRateLimitOptions', () => {
  it('maps maxRequests/windowSeconds to max/timeWindow', () => {
    const options = buildRateLimitOptions({ maxRequests: 100, windowSeconds: 60 });

    expect(options.max).toBe(100);
    expect(options.timeWindow).toBe('60 seconds');
  });

  describe('keyGenerator — issue #15729 (X-Forwarded-For rate-limit bypass)', () => {
    it('keys on the real socket peer, ignoring a spoofed X-Forwarded-For, when no trustedProxies are configured', () => {
      const options = buildRateLimitOptions({ maxRequests: 100, windowSeconds: 60 });

      const first = createMockRequest({
        remoteAddress: '198.51.100.7',
        headers: { 'x-forwarded-for': '1.1.1.1' },
      });
      const second = createMockRequest({
        remoteAddress: '198.51.100.7',
        headers: { 'x-forwarded-for': '2.2.2.2' },
      });

      // Same attacker socket, different forged X-Forwarded-For on each request —
      // must resolve to the SAME rate-limit key, or the limiter is trivially
      // bypassable by sending a fresh header value per request.
      expect(options.keyGenerator(first)).toBe(options.keyGenerator(second));
      expect(options.keyGenerator(first)).toBe('198.51.100.7');
    });

    it('keys on the forwarded IP only when the socket peer is a configured trusted proxy', () => {
      const options = buildRateLimitOptions({ maxRequests: 100, windowSeconds: 60 }, '10.0.0.0/8');

      const request = createMockRequest({
        remoteAddress: '10.0.0.5',
        headers: { 'x-forwarded-for': '203.0.113.9' },
      });

      expect(options.keyGenerator(request)).toBe('203.0.113.9');
    });
  });
});

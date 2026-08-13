/**
 * Tests for getClientIp() trusted proxy validation.
 *
 * Issue: kasbly/kasbly#15729 — the connector previously set `trustProxy: true`
 * unconditionally, so Fastify derived `request.ip` from an attacker-controlled
 * X-Forwarded-For header. That request.ip then fed the rate limiter's default
 * key and the audit log's `ip` field, letting a caller bypass the rate limit
 * (fresh header value -> fresh bucket) and forge audit-log IP attribution.
 *
 * These tests verify the fix: forwarded headers (x-forwarded-for, x-real-ip)
 * are only trusted when the direct socket peer matches `trustedProxies`, and
 * the raw socket peer is used otherwise — fail closed against spoofing.
 */
import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { getClientIp } from '../client-ip.js';

function createMockRequest(overrides: {
  remoteAddress?: string;
  headers?: Record<string, string | string[] | undefined>;
}): FastifyRequest {
  return {
    socket: { remoteAddress: overrides.remoteAddress ?? '127.0.0.1' },
    headers: overrides.headers ?? {},
  } as unknown as FastifyRequest;
}

describe('getClientIp — trusted proxy validation (issue #15729)', () => {
  describe('forwarded headers trusted when the direct peer is an allowed proxy', () => {
    it('uses the rightmost untrusted x-forwarded-for IP when the socket peer is trusted', () => {
      const req = createMockRequest({
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': '198.51.100.99, 203.0.113.50' },
      });

      expect(getClientIp(req, '127.0.0.1')).toBe('203.0.113.50');
    });

    it('uses x-real-ip when the socket peer is trusted and no x-forwarded-for is present', () => {
      const req = createMockRequest({
        remoteAddress: '127.0.0.1',
        headers: { 'x-real-ip': '203.0.113.99' },
      });

      expect(getClientIp(req, '127.0.0.1')).toBe('203.0.113.99');
    });

    it('x-forwarded-for takes priority over x-real-ip when both are present', () => {
      const req = createMockRequest({
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': '203.0.113.50', 'x-real-ip': '203.0.113.99' },
      });

      expect(getClientIp(req, '127.0.0.1')).toBe('203.0.113.50');
    });

    it('matches a CIDR range in trustedProxies (10.0.0.0/8 covers 10.0.0.1)', () => {
      const req = createMockRequest({
        remoteAddress: '10.0.0.1',
        headers: { 'x-forwarded-for': '198.51.100.1' },
      });

      expect(getClientIp(req, '10.0.0.0/8')).toBe('198.51.100.1');
    });

    it('handles x-forwarded-for as an array and walks all values right-to-left', () => {
      const req = createMockRequest({
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': ['198.51.100.99', '203.0.113.50'] },
      });

      expect(getClientIp(req, '127.0.0.1')).toBe('203.0.113.50');
    });

    it('falls back to the direct IP when every x-forwarded-for hop is trusted', () => {
      const req = createMockRequest({
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': '10.0.0.4, 10.0.0.5' },
      });

      expect(getClientIp(req, '127.0.0.1,10.0.0.0/8')).toBe('127.0.0.1');
    });

    it('handles x-real-ip as an array', () => {
      const req = createMockRequest({
        remoteAddress: '127.0.0.1',
        headers: { 'x-real-ip': ['203.0.113.99'] },
      });

      expect(getClientIp(req, '127.0.0.1')).toBe('203.0.113.99');
    });

    it('falls back to the direct IP when x-forwarded-for is an empty string', () => {
      const req = createMockRequest({
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': '' },
      });

      expect(getClientIp(req, '127.0.0.1')).toBe('127.0.0.1');
    });
  });

  describe('forwarded headers ignored — fail closed against spoofing', () => {
    it('ignores trustedProxies being unset entirely (default, self-hosted deployment)', () => {
      const req = createMockRequest({
        remoteAddress: '203.0.113.50',
        headers: { 'x-forwarded-for': '198.51.100.1, 10.0.0.1' },
      });

      expect(getClientIp(req, undefined)).toBe('203.0.113.50');
    });

    it('ignores x-forwarded-for when the direct peer is not in trustedProxies', () => {
      const req = createMockRequest({
        remoteAddress: '192.168.1.1',
        headers: { 'x-forwarded-for': '203.0.113.50, 10.0.0.5' },
      });

      expect(getClientIp(req, '127.0.0.1')).toBe('192.168.1.1');
    });

    it('ignores x-real-ip when the direct peer is not in trustedProxies', () => {
      const req = createMockRequest({
        remoteAddress: '192.168.1.1',
        headers: { 'x-real-ip': '203.0.113.99' },
      });

      expect(getClientIp(req, '127.0.0.1')).toBe('192.168.1.1');
    });

    it('ignores a spoofed x-forwarded-for from an untrusted origin (rate-limit bypass attempt)', () => {
      const req = createMockRequest({
        remoteAddress: '198.51.100.7',
        headers: { 'x-forwarded-for': `spoofed-${Math.random()}` },
      });

      expect(getClientIp(req, undefined)).toBe('198.51.100.7');
    });

    it('ignores x-forwarded-for when the peer is outside the trusted CIDR range', () => {
      const req = createMockRequest({
        remoteAddress: '203.0.113.50',
        headers: { 'x-forwarded-for': '198.51.100.1' },
      });

      expect(getClientIp(req, '10.0.0.0/8')).toBe('203.0.113.50');
    });
  });

  describe('allowlist gating of multi-hop X-Forwarded-For chains (issue #17415)', () => {
    it('ignores a multi-hop chain entirely when the socket peer is not allowlisted', () => {
      // The attacker connects directly and pre-forges a plausible proxy chain.
      const req = createMockRequest({
        remoteAddress: '198.51.100.7',
        headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.5, 127.0.0.1' },
      });

      expect(getClientIp(req, '10.0.0.0/8')).toBe('198.51.100.7');
    });

    it('ignores the chain when the peer is one address outside the trusted CIDR', () => {
      // 10.0.0.0/8 ends at 10.255.255.255; 11.0.0.0 is the next address up.
      const req = createMockRequest({
        remoteAddress: '11.0.0.0',
        headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.5' },
      });

      expect(getClientIp(req, '10.0.0.0/8')).toBe('11.0.0.0');
    });

    it('trusts the chain when the peer is the last address inside the trusted CIDR', () => {
      const req = createMockRequest({
        remoteAddress: '10.255.255.255',
        headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.5' },
      });

      expect(getClientIp(req, '10.0.0.0/8')).toBe('203.0.113.9');
    });

    it('ignores a forged leftmost hop and returns the rightmost untrusted hop', () => {
      const req = createMockRequest({
        remoteAddress: '10.0.0.5',
        headers: { 'x-forwarded-for': '198.51.100.4, 203.0.113.9, 10.0.0.6' },
      });

      expect(getClientIp(req, '10.0.0.0/8')).toBe('203.0.113.9');
    });

    it('ignores forwarded headers when the allowlist is an empty string', () => {
      const req = createMockRequest({
        remoteAddress: '10.0.0.5',
        headers: { 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9' },
      });

      expect(getClientIp(req, '')).toBe('10.0.0.5');
    });

    it('ignores forwarded headers when the allowlist holds only separators', () => {
      const req = createMockRequest({
        remoteAddress: '10.0.0.5',
        headers: { 'x-forwarded-for': '203.0.113.9' },
      });

      expect(getClientIp(req, ',,')).toBe('10.0.0.5');
    });

    it('does not trust an absent socket peer against a degenerate allowlist', () => {
      // No remoteAddress at all: the empty direct IP must not exact-match the
      // empty entry produced by a trailing comma and unlock the header.
      const req = {
        socket: { remoteAddress: undefined },
        headers: { 'x-forwarded-for': '203.0.113.9' },
      } as unknown as FastifyRequest;

      expect(getClientIp(req, '10.0.0.0/8,')).toBe('unknown');
    });
  });

  describe('direct IP fallback handling', () => {
    it('returns "unknown" when there is no socket peer and no proxy headers', () => {
      const req = {
        socket: { remoteAddress: undefined },
        headers: {},
      } as unknown as FastifyRequest;

      expect(getClientIp(req, '127.0.0.1')).toBe('unknown');
    });

    it('uses the direct socket peer when no forwarded headers are present', () => {
      const req = createMockRequest({ remoteAddress: '203.0.113.10', headers: {} });

      expect(getClientIp(req, undefined)).toBe('203.0.113.10');
    });
  });
});

import type { FastifyRequest } from 'fastify';
import { isIpAllowed } from './ip-allowlist.js';

/**
 * Resolves the client IP for a request, respecting proxy headers only when
 * the direct socket peer is a configured trusted proxy.
 *
 * SECURITY: The connector is merchant-self-hosted and binds `0.0.0.0` with no
 * guaranteed reverse proxy in front of it (see docker-compose.yml — the port
 * is published directly, no bundled nginx/traefik). Blindly trusting
 * X-Forwarded-For (as `trustProxy: true` does) lets any caller spoof
 * `request.ip` by sending an arbitrary header value, which both defeats the
 * per-IP rate limiter (a fresh header value on every request lands in a
 * fresh bucket) and forges the IP recorded in the audit log.
 *
 * This mirrors the fail-closed design of the main API's
 * `apps/api/src/shared/security/client-ip.ts`: the socket peer is the trust
 * root, and forwarded headers are only honored when that peer matches
 * `server.trustedProxies` (comma-separated IP/CIDR allowlist). When
 * `trustedProxies` is unset — the default for a self-hosted deployment with
 * unknown topology — forwarded headers are ignored entirely and the raw
 * socket peer address is used.
 */
export function getClientIp(request: FastifyRequest, trustedProxies?: string): string {
  const directIp = request.socket?.remoteAddress ?? '';
  const shouldTrustProxyHeaders = Boolean(
    trustedProxies && directIp && isIpAllowed(directIp, trustedProxies),
  );

  if (shouldTrustProxyHeaders) {
    const forwardedFor = request.headers['x-forwarded-for'];
    if (forwardedFor) {
      const ipString = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
      const forwardedIps = ipString
        .split(',')
        .map((ip) => ip.trim())
        .filter(Boolean);

      // Proxies append hops to the right, so the leftmost entries can be
      // client-forged. Stop at the first hop outside our trusted boundary.
      for (let index = forwardedIps.length - 1; index >= 0; index -= 1) {
        const ip = forwardedIps[index]!;
        if (!isIpAllowed(ip, trustedProxies ?? '')) {
          return ip;
        }
      }
    }

    const realIp = request.headers['x-real-ip'];
    if (realIp) {
      const ip = Array.isArray(realIp) ? realIp[0] : realIp;
      if (ip) {
        return ip;
      }
    }
  }

  return directIp || 'unknown';
}

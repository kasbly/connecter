/**
 * IP allowlisting utilities for trusted proxy validation.
 *
 * SECURITY: When the connector sits behind a reverse proxy, the client IP is
 * forwarded via X-Forwarded-For / X-Real-IP. Without validating that the
 * *direct* connection originates from a trusted proxy, an attacker can spoof
 * these headers to bypass rate limiting or forge audit-log IP attribution.
 *
 * These helpers validate that the direct socket peer IP matches an allowlist
 * before any forwarded header is trusted.
 */

/**
 * Checks whether clientIp matches any entry in a comma-separated allowlist.
 * Supports individual IPv4 addresses and CIDR notation (e.g. `10.0.0.0/8`).
 *
 * SECURITY: fails closed on an unknown peer. Splitting an empty (or
 * trailing-comma) allowlist yields an empty entry, and the exact-match branch
 * below is plain string equality — so without this guard an absent socket peer
 * (`request.socket.remoteAddress === undefined`, surfaced as `''`) would
 * exact-match that empty entry and be treated as a trusted proxy, unlocking
 * X-Forwarded-For. An unidentifiable peer is never trusted.
 */
export function isIpAllowed(clientIp: string, allowlist: string): boolean {
  if (!clientIp) return false;
  const allowed = allowlist.split(',').map((entry) => entry.trim());
  for (const entry of allowed) {
    if (entry.includes('/')) {
      if (isIpInCidr(clientIp, entry)) return true;
    } else if (clientIp === entry) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true when ip falls within the IPv4 CIDR range cidr (e.g. `203.0.113.0/24`).
 * Does not support IPv6.
 */
export function isIpInCidr(ip: string, cidr: string): boolean {
  const parts = cidr.split('/');
  const bitsStr = parts[1];
  if (bitsStr === undefined) return false;
  const bits = parseInt(bitsStr, 10);
  if (isNaN(bits) || bits < 0 || bits > 32) return false;
  const range = parts[0]!;
  const mask = ~(2 ** (32 - bits) - 1);

  const ipNum = ipv4ToNumber(ip);
  const rangeNum = ipv4ToNumber(range);

  if (ipNum === null || rangeNum === null) return false;
  return (ipNum & mask) === (rangeNum & mask);
}

/** Parses a dotted-quad IPv4 string to a 32-bit unsigned integer, or null on invalid input. */
function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (const part of parts) {
    const n = parseInt(part, 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    num = (num << 8) | n;
  }
  return num >>> 0;
}

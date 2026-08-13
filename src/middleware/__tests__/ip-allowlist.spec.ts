/**
 * Tests for the connector's IP-allowlist security helpers (issue #17415).
 *
 * SECURITY CONTRACT: `isIpAllowed` is the trust root for `getClientIp` — it
 * decides whether the *direct socket peer* is a configured reverse proxy and
 * therefore whether an `X-Forwarded-For` / `X-Real-IP` header may be believed
 * at all. Widening it lets any caller spoof the IP that feeds the per-IP rate
 * limiter and the audit log; narrowing it rejects legitimate proxy traffic.
 *
 * Every expected value below is a hand-computed range boundary, written as a
 * literal. Nothing here re-derives a mask or re-implements the bit math the
 * subject uses — otherwise a sign/off-by-one error in `isIpInCidr` would be
 * mirrored by the test and pass. The ranges asserted are:
 *
 *   0.0.0.0/1        -> 0.0.0.0         .. 127.255.255.255
 *   128.0.0.0/1      -> 128.0.0.0       .. 255.255.255.255
 *   10.0.0.0/8       -> 10.0.0.0        .. 10.255.255.255
 *   100.64.0.0/10    -> 100.64.0.0      .. 100.127.255.255
 *   172.16.0.0/12    -> 172.16.0.0      .. 172.31.255.255
 *   192.168.0.0/16   -> 192.168.0.0     .. 192.168.255.255
 *   10.1.16.0/20     -> 10.1.16.0       .. 10.1.31.255
 *   203.0.113.0/24   -> 203.0.113.0     .. 203.0.113.255
 *   10.0.0.0/31      -> 10.0.0.0        .. 10.0.0.1
 *   198.51.100.7/32  -> 198.51.100.7    only
 *
 * The DENY paths matter more than the allow paths here, so malformed input,
 * empty allowlists and IPv6 each get explicit fail-closed coverage.
 */
import { describe, expect, it } from 'vitest';
import { isIpAllowed, isIpInCidr } from '../ip-allowlist.js';

describe('isIpInCidr — IPv4 CIDR matching (issue #17415)', () => {
  describe('/24 — boundaries just inside and just outside', () => {
    it('matches the network address itself', () => {
      expect(isIpInCidr('203.0.113.0', '203.0.113.0/24')).toBe(true);
    });

    it('matches the last address in the range (203.0.113.255)', () => {
      expect(isIpInCidr('203.0.113.255', '203.0.113.0/24')).toBe(true);
    });

    it('matches a host in the middle of the range', () => {
      expect(isIpInCidr('203.0.113.42', '203.0.113.0/24')).toBe(true);
    });

    it('rejects the address one below the range (203.0.112.255)', () => {
      expect(isIpInCidr('203.0.112.255', '203.0.113.0/24')).toBe(false);
    });

    it('rejects the address one above the range (203.0.114.0)', () => {
      expect(isIpInCidr('203.0.114.0', '203.0.113.0/24')).toBe(false);
    });

    it('ignores host bits already set in the range operand (203.0.113.77/24)', () => {
      expect(isIpInCidr('203.0.113.1', '203.0.113.77/24')).toBe(true);
      expect(isIpInCidr('203.0.114.1', '203.0.113.77/24')).toBe(false);
    });
  });

  describe('/32 — single host, the narrowest useful allowlist entry', () => {
    it('matches only the exact address', () => {
      expect(isIpInCidr('198.51.100.7', '198.51.100.7/32')).toBe(true);
    });

    it('rejects the address one below (198.51.100.6)', () => {
      expect(isIpInCidr('198.51.100.6', '198.51.100.7/32')).toBe(false);
    });

    it('rejects the address one above (198.51.100.8)', () => {
      expect(isIpInCidr('198.51.100.8', '198.51.100.7/32')).toBe(false);
    });

    it('rejects a /32 whose high bit is set only when the address differs', () => {
      // 255.255.255.255/32 exercises the all-ones mask against an operand that
      // is negative when read as a signed 32-bit integer.
      expect(isIpInCidr('255.255.255.255', '255.255.255.255/32')).toBe(true);
      expect(isIpInCidr('255.255.255.254', '255.255.255.255/32')).toBe(false);
    });
  });

  describe('/8 — first-octet-only match', () => {
    it('matches the bottom of the range (10.0.0.0)', () => {
      expect(isIpInCidr('10.0.0.0', '10.0.0.0/8')).toBe(true);
    });

    it('matches the top of the range (10.255.255.255)', () => {
      expect(isIpInCidr('10.255.255.255', '10.0.0.0/8')).toBe(true);
    });

    it('rejects the address one below the range (9.255.255.255)', () => {
      expect(isIpInCidr('9.255.255.255', '10.0.0.0/8')).toBe(false);
    });

    it('rejects the address one above the range (11.0.0.0)', () => {
      expect(isIpInCidr('11.0.0.0', '10.0.0.0/8')).toBe(false);
    });
  });

  describe('/0 — matches every parseable IPv4 address', () => {
    it('matches the lowest address (0.0.0.0)', () => {
      expect(isIpInCidr('0.0.0.0', '0.0.0.0/0')).toBe(true);
    });

    it('matches the highest address (255.255.255.255)', () => {
      expect(isIpInCidr('255.255.255.255', '0.0.0.0/0')).toBe(true);
    });

    it('matches regardless of the range operand, since no bits are compared', () => {
      expect(isIpInCidr('203.0.113.9', '10.11.12.13/0')).toBe(true);
    });

    it('still rejects an unparseable address — /0 does not bypass validation', () => {
      expect(isIpInCidr('not-an-ip', '0.0.0.0/0')).toBe(false);
      expect(isIpInCidr('::1', '0.0.0.0/0')).toBe(false);
    });

    it('still rejects an unparseable range operand', () => {
      expect(isIpInCidr('203.0.113.9', 'not-an-ip/0')).toBe(false);
    });
  });

  describe('/1 and /31 — the extremes where signed 32-bit arithmetic can go wrong', () => {
    it('0.0.0.0/1 covers the lower half and stops at 127.255.255.255', () => {
      expect(isIpInCidr('0.0.0.0', '0.0.0.0/1')).toBe(true);
      expect(isIpInCidr('127.255.255.255', '0.0.0.0/1')).toBe(true);
      expect(isIpInCidr('128.0.0.0', '0.0.0.0/1')).toBe(false);
      expect(isIpInCidr('255.255.255.255', '0.0.0.0/1')).toBe(false);
    });

    it('128.0.0.0/1 covers the upper half and stops at 128.0.0.0', () => {
      expect(isIpInCidr('128.0.0.0', '128.0.0.0/1')).toBe(true);
      expect(isIpInCidr('255.255.255.255', '128.0.0.0/1')).toBe(true);
      expect(isIpInCidr('127.255.255.255', '128.0.0.0/1')).toBe(false);
      expect(isIpInCidr('0.0.0.0', '128.0.0.0/1')).toBe(false);
    });

    it('10.0.0.0/31 covers exactly two addresses', () => {
      expect(isIpInCidr('10.0.0.0', '10.0.0.0/31')).toBe(true);
      expect(isIpInCidr('10.0.0.1', '10.0.0.0/31')).toBe(true);
      expect(isIpInCidr('10.0.0.2', '10.0.0.0/31')).toBe(false);
    });
  });

  describe('non-octet-aligned prefixes', () => {
    it('172.16.0.0/12 spans 172.16.0.0 – 172.31.255.255', () => {
      expect(isIpInCidr('172.16.0.0', '172.16.0.0/12')).toBe(true);
      expect(isIpInCidr('172.31.255.255', '172.16.0.0/12')).toBe(true);
      expect(isIpInCidr('172.15.255.255', '172.16.0.0/12')).toBe(false);
      expect(isIpInCidr('172.32.0.0', '172.16.0.0/12')).toBe(false);
    });

    it('100.64.0.0/10 spans 100.64.0.0 – 100.127.255.255', () => {
      expect(isIpInCidr('100.64.0.0', '100.64.0.0/10')).toBe(true);
      expect(isIpInCidr('100.127.255.255', '100.64.0.0/10')).toBe(true);
      expect(isIpInCidr('100.63.255.255', '100.64.0.0/10')).toBe(false);
      expect(isIpInCidr('100.128.0.0', '100.64.0.0/10')).toBe(false);
    });

    it('10.1.16.0/20 spans 10.1.16.0 – 10.1.31.255', () => {
      expect(isIpInCidr('10.1.16.0', '10.1.16.0/20')).toBe(true);
      expect(isIpInCidr('10.1.31.255', '10.1.16.0/20')).toBe(true);
      expect(isIpInCidr('10.1.15.255', '10.1.16.0/20')).toBe(false);
      expect(isIpInCidr('10.1.32.0', '10.1.16.0/20')).toBe(false);
    });

    it('192.168.0.0/16 spans 192.168.0.0 – 192.168.255.255', () => {
      // First octet >= 128, so the accumulated value is negative before the
      // final unsigned coercion — a regression there would break this range.
      expect(isIpInCidr('192.168.0.0', '192.168.0.0/16')).toBe(true);
      expect(isIpInCidr('192.168.255.255', '192.168.0.0/16')).toBe(true);
      expect(isIpInCidr('192.167.255.255', '192.168.0.0/16')).toBe(false);
      expect(isIpInCidr('192.169.0.0', '192.168.0.0/16')).toBe(false);
    });
  });

  describe('malformed prefix length — fail closed', () => {
    it('rejects a prefix length above 32', () => {
      expect(isIpInCidr('10.0.0.1', '10.0.0.0/33')).toBe(false);
      expect(isIpInCidr('10.0.0.1', '10.0.0.0/128')).toBe(false);
    });

    it('rejects a negative prefix length', () => {
      expect(isIpInCidr('10.0.0.1', '10.0.0.0/-1')).toBe(false);
    });

    it('rejects a non-numeric prefix length', () => {
      expect(isIpInCidr('10.0.0.1', '10.0.0.0/abc')).toBe(false);
    });

    it('rejects an empty prefix length', () => {
      expect(isIpInCidr('10.0.0.1', '10.0.0.0/')).toBe(false);
    });

    it('rejects input with no slash at all', () => {
      expect(isIpInCidr('10.0.0.1', '10.0.0.0')).toBe(false);
      expect(isIpInCidr('10.0.0.1', '10.0.0.1')).toBe(false);
    });
  });

  describe('malformed addresses — fail closed', () => {
    it('rejects an octet above 255', () => {
      expect(isIpInCidr('256.0.0.1', '0.0.0.0/0')).toBe(false);
      expect(isIpInCidr('10.0.0.256', '10.0.0.0/8')).toBe(false);
    });

    it('rejects a negative octet', () => {
      expect(isIpInCidr('10.-1.0.1', '10.0.0.0/8')).toBe(false);
    });

    it('rejects a three-octet address', () => {
      expect(isIpInCidr('10.0.1', '10.0.0.0/8')).toBe(false);
    });

    it('rejects a five-octet address', () => {
      expect(isIpInCidr('10.0.0.1.5', '10.0.0.0/8')).toBe(false);
    });

    it('rejects an empty octet', () => {
      expect(isIpInCidr('10..0.1', '10.0.0.0/8')).toBe(false);
    });

    it('rejects an empty address', () => {
      expect(isIpInCidr('', '0.0.0.0/0')).toBe(false);
    });

    it('rejects a malformed range operand — a typo in the allowlist denies, never matches everything', () => {
      expect(isIpInCidr('10.0.0.1', '10.0.0/8')).toBe(false);
      expect(isIpInCidr('10.0.0.1', '999.0.0.0/8')).toBe(false);
      expect(isIpInCidr('10.0.0.1', '/8')).toBe(false);
    });

    it('parses octets as decimal, so a leading zero is not read as octal', () => {
      // '010' is 10, not 8 — no octal-ambiguity bypass of a decimal allowlist.
      expect(isIpInCidr('010.0.0.1', '10.0.0.0/8')).toBe(true);
      expect(isIpInCidr('010.0.0.1', '8.0.0.0/8')).toBe(false);
    });

    it('rejects hex octet notation', () => {
      expect(isIpInCidr('0x0a.0.0.1', '10.0.0.0/8')).toBe(false);
    });
  });

  describe('IPv6 — unsupported by design, denies rather than throwing', () => {
    it('rejects loopback, link-local and documentation IPv6 addresses', () => {
      expect(isIpInCidr('::1', '0.0.0.0/0')).toBe(false);
      expect(isIpInCidr('fe80::1', '10.0.0.0/8')).toBe(false);
      expect(isIpInCidr('2001:db8::1', '0.0.0.0/0')).toBe(false);
    });

    it('rejects an IPv6 CIDR range operand', () => {
      expect(isIpInCidr('10.0.0.1', '2001:db8::/32')).toBe(false);
    });

    it('rejects an IPv4-mapped IPv6 peer even when the mapped IPv4 is in range', () => {
      // DOCUMENTED GAP, deliberately fail-closed and pinned here: a Node
      // dual-stack listener reports IPv4 peers as `::ffff:a.b.c.d`, and that
      // form does NOT match `10.0.0.0/8`. The consequence is a legitimate
      // proxy being distrusted (forwarded headers ignored), never an untrusted
      // peer being trusted. Adding IPv6/mapped-IPv4 support is out of scope for
      // #17415; if it is ever added, this expectation is what must change.
      expect(isIpInCidr('::ffff:10.0.0.1', '10.0.0.0/8')).toBe(false);
      expect(isIpInCidr('::ffff:127.0.0.1', '127.0.0.0/8')).toBe(false);
    });
  });
});

describe('isIpAllowed — comma-separated allowlist (issue #17415)', () => {
  describe('exact-match entries', () => {
    it('matches an exact single-entry allowlist', () => {
      expect(isIpAllowed('127.0.0.1', '127.0.0.1')).toBe(true);
    });

    it('rejects a different address', () => {
      expect(isIpAllowed('127.0.0.2', '127.0.0.1')).toBe(false);
    });

    it('rejects an address that merely has the entry as a prefix', () => {
      expect(isIpAllowed('127.0.0.10', '127.0.0.1')).toBe(false);
    });

    it('trims surrounding whitespace on entries', () => {
      expect(isIpAllowed('127.0.0.1', '  127.0.0.1  ')).toBe(true);
      expect(isIpAllowed('10.0.0.5', '127.0.0.1 , 10.0.0.5 , 192.168.1.1')).toBe(true);
    });
  });

  describe('mixed exact + CIDR allowlists', () => {
    const allowlist = '127.0.0.1, 10.0.0.0/8, 203.0.113.7, 192.168.0.0/16';

    it('matches via an exact entry', () => {
      expect(isIpAllowed('127.0.0.1', allowlist)).toBe(true);
      expect(isIpAllowed('203.0.113.7', allowlist)).toBe(true);
    });

    it('matches via a CIDR entry', () => {
      expect(isIpAllowed('10.4.5.6', allowlist)).toBe(true);
      expect(isIpAllowed('192.168.99.1', allowlist)).toBe(true);
    });

    it('matches an entry that is not the first in the list', () => {
      expect(isIpAllowed('192.168.255.255', allowlist)).toBe(true);
    });

    it('rejects an address covered by no entry', () => {
      expect(isIpAllowed('198.51.100.1', allowlist)).toBe(false);
      expect(isIpAllowed('11.0.0.1', allowlist)).toBe(false);
      expect(isIpAllowed('203.0.113.8', allowlist)).toBe(false);
      expect(isIpAllowed('192.169.0.1', allowlist)).toBe(false);
    });

    it('does not let a malformed entry short-circuit later valid entries', () => {
      expect(isIpAllowed('10.0.0.1', 'garbage/24, 10.0.0.0/8')).toBe(true);
    });

    it('denies when every entry is malformed', () => {
      expect(isIpAllowed('10.0.0.1', 'garbage/24, 999.999.999.999/8, /33')).toBe(false);
    });
  });

  describe('empty and degenerate allowlists — fail closed', () => {
    it('denies against an empty allowlist string', () => {
      expect(isIpAllowed('10.0.0.1', '')).toBe(false);
    });

    it('denies against an allowlist of only separators and whitespace', () => {
      expect(isIpAllowed('10.0.0.1', ',,,')).toBe(false);
      expect(isIpAllowed('10.0.0.1', '   ')).toBe(false);
    });

    it('denies an empty client IP even when the allowlist is empty', () => {
      // Regression guard: an empty allowlist splits to a single empty entry,
      // which used to exact-match an empty client IP and return true — an
      // absent socket peer would have been treated as a trusted proxy.
      expect(isIpAllowed('', '')).toBe(false);
    });

    it('denies an empty client IP against an allowlist with a trailing separator', () => {
      expect(isIpAllowed('', '10.0.0.0/8,')).toBe(false);
      expect(isIpAllowed('', '127.0.0.1, ')).toBe(false);
    });

    it('denies an empty client IP against a populated allowlist', () => {
      expect(isIpAllowed('', '127.0.0.1, 10.0.0.0/8')).toBe(false);
    });

    it('still honours real entries when the allowlist has a trailing separator', () => {
      expect(isIpAllowed('10.0.0.1', '10.0.0.0/8,')).toBe(true);
      expect(isIpAllowed('198.51.100.1', '10.0.0.0/8,')).toBe(false);
    });
  });

  describe('IPv6 clients', () => {
    it('denies an IPv6 client against an IPv4 CIDR allowlist', () => {
      expect(isIpAllowed('::1', '127.0.0.0/8, 10.0.0.0/8')).toBe(false);
      expect(isIpAllowed('::ffff:127.0.0.1', '127.0.0.0/8')).toBe(false);
    });

    it('allows an IPv6 client only via a byte-identical exact entry', () => {
      // Exact entries are plain string equality, so an operator can allowlist a
      // literal IPv6 peer — but only in the exact textual form the socket
      // reports. Equivalent spellings do not match.
      expect(isIpAllowed('::1', '::1')).toBe(true);
      expect(isIpAllowed('::1', '0:0:0:0:0:0:0:1')).toBe(false);
      expect(isIpAllowed('::ffff:127.0.0.1', '::ffff:127.0.0.1')).toBe(true);
    });
  });
});

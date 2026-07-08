/**
 * SSRF guard for web_fetch. Untrusted web content can prompt-inject the agent
 * into fetching internal endpoints (cloud metadata at 169.254.169.254, admin
 * panels on 127.0.0.1, private RFC-1918 hosts). This resolves a URL's hostname
 * and rejects it if any resolved address is loopback, private, link-local, or
 * otherwise non-public.
 *
 * Note: there is a residual TOCTOU/DNS-rebinding gap between this resolution and
 * fetch()'s own resolution; this is defense-in-depth, not a hard sandbox.
 */

import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const blocklist = new BlockList();

// IPv4 ranges that must never be fetched.
const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this host"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (incl. cloud metadata)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
];
for (const [net, prefix] of V4_BLOCKED) blocklist.addSubnet(net, prefix, "ipv4");
blocklist.addAddress("255.255.255.255", "ipv4"); // broadcast

// IPv6 ranges.
const V6_BLOCKED: Array<[string, number]> = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
];
for (const [net, prefix] of V6_BLOCKED) blocklist.addSubnet(net, prefix, "ipv6");

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** Collapse an IPv4-mapped IPv6 address (`::ffff:127.0.0.1`) to its IPv4 form. */
function unmapV4(addr: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  return m?.[1] ?? addr;
}

function isBlockedIp(addr: string): boolean {
  const a = unmapV4(addr);
  const fam = isIP(a);
  if (fam === 4) return blocklist.check(a, "ipv4");
  if (fam === 6) return blocklist.check(a, "ipv6");
  return true; // unparseable → block, fail closed
}

export interface SsrfResult {
  blocked: boolean;
  reason?: string;
}

/**
 * Resolve `hostname` and report whether it points at a non-public address.
 * IP literals are checked directly; names are resolved (all A/AAAA records)
 * and blocked if any address is non-public. Resolution failure fails closed.
 */
export async function checkHostname(hostname: string): Promise<SsrfResult> {
  const host = stripBrackets(hostname).trim().toLowerCase();
  if (!host) return { blocked: true, reason: "empty host" };

  // Fast, clear rejections for obvious local names.
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return { blocked: true, reason: `'${hostname}' is a local hostname` };
  }

  // IP literal → check directly, no DNS.
  if (isIP(host)) {
    return isBlockedIp(host)
      ? { blocked: true, reason: `'${hostname}' is a private or reserved address` }
      : { blocked: false };
  }

  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    return { blocked: true, reason: `could not resolve '${hostname}'` };
  }
  if (addrs.length === 0) return { blocked: true, reason: `'${hostname}' did not resolve` };

  for (const { address } of addrs) {
    if (isBlockedIp(address)) {
      return {
        blocked: true,
        reason: `'${hostname}' resolves to a private or reserved address (${address})`,
      };
    }
  }
  return { blocked: false };
}

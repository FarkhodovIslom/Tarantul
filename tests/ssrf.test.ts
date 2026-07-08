/**
 * SSRF guard: IP-literal and local-name checks are deterministic (no DNS), so
 * we assert those directly. Name resolution is covered indirectly via the
 * WebFetchTool tests in web.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { checkHostname } from "../src/agent/tools/ssrf.js";

describe("checkHostname", () => {
  it("blocks loopback, private, and CGNAT IPv4 literals", async () => {
    for (const host of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.9.9", "100.64.0.1"]) {
      expect((await checkHostname(host)).blocked).toBe(true);
    }
  });

  it("blocks the cloud metadata link-local address", async () => {
    const r = await checkHostname("169.254.169.254");
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("169.254.169.254");
  });

  it("blocks 0.0.0.0 and the broadcast address", async () => {
    expect((await checkHostname("0.0.0.0")).blocked).toBe(true);
    expect((await checkHostname("255.255.255.255")).blocked).toBe(true);
  });

  it("blocks IPv6 loopback with and without brackets", async () => {
    expect((await checkHostname("::1")).blocked).toBe(true);
    expect((await checkHostname("[::1]")).blocked).toBe(true);
  });

  it("blocks IPv6 unique-local and link-local", async () => {
    expect((await checkHostname("fc00::1")).blocked).toBe(true);
    expect((await checkHostname("fe80::1")).blocked).toBe(true);
  });

  it("unmaps IPv4-mapped IPv6 and blocks the underlying private address", async () => {
    expect((await checkHostname("::ffff:127.0.0.1")).blocked).toBe(true);
    expect((await checkHostname("[::ffff:169.254.169.254]")).blocked).toBe(true);
  });

  it("blocks localhost and .local / .localhost names without DNS", async () => {
    for (const host of ["localhost", "LOCALHOST", "foo.localhost", "printer.local"]) {
      expect((await checkHostname(host)).blocked).toBe(true);
    }
  });

  it("allows public IPv4 and IPv6 literals", async () => {
    expect((await checkHostname("8.8.8.8")).blocked).toBe(false);
    expect((await checkHostname("1.1.1.1")).blocked).toBe(false);
    expect((await checkHostname("2606:4700:4700::1111")).blocked).toBe(false);
  });

  it("fails closed on an empty host", async () => {
    expect((await checkHostname("")).blocked).toBe(true);
  });
});

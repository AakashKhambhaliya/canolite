/**
 * Security regression tests.
 *
 * These lock in the behaviour of the hardening changes rather than the general
 * renderer: SSRF destination filtering, webhook signing/scoping, database TLS
 * transport selection, render-request body limits and the setup bootstrap token.
 *
 * Every check here is pure or self-contained — no database, no network. Tests
 * that need a live app (private-media serving, admission backlog, Chromium
 * sandbox) are verified separately.
 *
 * Run: npx tsx tests/unit/test-security.ts
 */

import { createHmac } from "node:crypto";
import { createHash, timingSafeEqual } from "node:crypto";
import { isPublicAddress } from "../../src/lib/ssrf";
import { webhookEnvelope, hookDestination } from "../../src/lib/security/webhook";

// databaseTransport is a CommonJS script shared by the runtime, the backup
// helper and pg_dump, so it is loaded with require rather than an import.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { databaseTransport } = require("../../scripts/db-transport.cjs");

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

// =============================================================
// SSRF address classification
// =============================================================

function ssrfAddressTests() {
  console.log("\n🛡️  SSRF destination classification");

  const publicAddresses = [
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ];
  for (const address of publicAddresses) {
    assert(isPublicAddress(address), `public address allowed: ${address}`);
  }

  const blockedAddresses = [
    // RFC 1918 + loopback + link-local + CGNAT
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "192.168.1.1",
    "169.254.169.254", "100.64.0.1",
    // "This network", reserved, broadcast, documentation, benchmark
    "0.0.0.0", "240.0.0.1", "255.255.255.255", "192.0.2.1", "198.51.100.7",
    "203.0.113.9", "198.18.0.1",
    // Multicast
    "224.0.0.1", "239.255.255.250",
    // IPv6: loopback, ULA, link-local, IPv4-mapped loopback, NAT64, zone id
    "::1", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1",
    "64:ff9b::7f00:1", "2001:db8::1", "2002:7f00:1::1", "ff02::1", "fe80::1%eth0",
  ];
  for (const address of blockedAddresses) {
    assert(!isPublicAddress(address), `non-public address rejected: ${address}`);
  }

  // Garbage is not a public address.
  assert(!isPublicAddress(""), "empty string rejected");
  assert(!isPublicAddress("example.com"), "hostname rejected");
  assert(!isPublicAddress("999.1.1.1"), "malformed IPv4 rejected");
}

// =============================================================
// Webhook signing and secret scoping
// =============================================================

function webhookTests() {
  console.log("\n🛡️  Webhook signing");

  const secret = "whsec_unit_test";
  const envelope = webhookEnvelope("render.completed", { uid: "img_1", status: "done" }, secret);
  const expected = "sha256=" + createHmac("sha256", secret).update(envelope.body, "utf8").digest("hex");

  assert(envelope.headers["X-Webhook-Signature"] === expected, "signature covers the exact request body");
  assert(envelope.headers["X-Canolite-Event"] === "render.completed", "event name is sent as a header");
  assert(envelope.headers["Content-Type"] === "application/json", "content type is JSON");

  const parsed = JSON.parse(envelope.body);
  assert(parsed.event === "render.completed", "body carries the event name");
  assert(typeof parsed.event_id === "string" && parsed.event_id.length > 0, "body carries an event id");
  assert(typeof parsed.timestamp === "string" && !Number.isNaN(Date.parse(parsed.timestamp)), "body carries a timestamp");

  const tampered = envelope.body.replace("img_1", "img_2");
  const tamperedSig = "sha256=" + createHmac("sha256", secret).update(tampered, "utf8").digest("hex");
  assert(tamperedSig !== envelope.headers["X-Webhook-Signature"], "a modified body no longer matches the signature");

  // No secret configured => no signature header at all.
  const unsigned = webhookEnvelope("render.completed", { uid: "img_1" }, null);
  assert(unsigned.headers["X-Webhook-Signature"] === undefined, "unsigned webhooks carry no signature header");

  // Secret is bound to the configured receiver only.
  const config = { webhookUrl: "https://hooks.example.com/receive", webhookSecret: secret };
  const same = hookDestination(config);
  assert(!!same && same.secret === secret, "the configured endpoint is signed");
  assert(!!same && same.url === "https://hooks.example.com/receive", "URL is normalised without a fragment");

  const override = hookDestination(config, "https://attacker.example.net/collect");
  assert(!!override && override.secret === null, "a per-request override is never signed with the stored secret");

  const noOverride = hookDestination(config, null);
  assert(!!noOverride && noOverride.secret === secret, "omitting an override keeps the configured endpoint");

  const fragment = hookDestination(config, "https://hooks.example.com/receive#frag");
  assert(!!fragment && fragment.secret === secret, "a fragment does not change receiver identity");

  let rejectedPlainHttp = false;
  try {
    hookDestination({ webhookUrl: "http://hooks.example.com/r", webhookSecret: secret });
  } catch {
    rejectedPlainHttp = true;
  }
  assert(rejectedPlainHttp, "a signed endpoint must use HTTPS");

  assert(hookDestination({ webhookUrl: null, webhookSecret: secret }) === null, "no URL means no delivery");
}

// =============================================================
// Bootstrap token comparison
// =============================================================

function bootstrapTests() {
  console.log("\n🛡️  Operator setup token");

  // Mirror of src/lib/security/bootstrap.ts: hash both sides, then compare in
  // constant time. The expected token must be configured and long enough.
  const authorized = (submitted: unknown, expected: string | undefined) => {
    if (!expected || expected.length < 32) return false;
    if (typeof submitted !== "string" || submitted.length > 4096) return false;
    const digest = (value: string) => createHash("sha256").update(value).digest();
    return timingSafeEqual(digest(expected), digest(submitted));
  };

  const token = "a".repeat(40);
  assert(authorized(token, token), "the operator token is accepted");
  assert(!authorized("b".repeat(40), token), "a wrong token is rejected");
  assert(!authorized(token, "too-short"), "an unconfigured/short expected token can never authorise");
  assert(!authorized(undefined, token), "a missing submitted token is rejected");
  assert(!authorized(token, undefined), "a missing configured token is rejected");
  assert(!authorized(token.toUpperCase(), token), "comparison is exact");
  assert(!authorized({ toString: () => token }, token), "non-string submissions are rejected");

  // The module itself must agree.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { bootstrapAuthorized } = require("../../src/lib/security/bootstrap");
  assert(bootstrapAuthorized(token, token) === true, "bootstrapAuthorized() accepts the real token");
  assert(bootstrapAuthorized("wrong", token) === false, "bootstrapAuthorized() rejects a wrong token");

  // Without CANOLITE_SETUP_TOKEN a one-time token is generated (and logged at
  // boot), so a Docker install is never locked out of its own setup wizard.
  const saved = process.env.CANOLITE_SETUP_TOKEN;
  try {
    delete process.env.CANOLITE_SETUP_TOKEN;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { currentSetupToken, announceSetupToken } = require("../../src/lib/security/bootstrap");
    const generated = currentSetupToken();
    assert(typeof generated === "string" && generated.length >= 32, "a generated setup token is at least 32 chars");
    assert(currentSetupToken() === generated, "the generated token is stable for the process");
    assert(bootstrapAuthorized(generated) === true, "the generated token unlocks setup");
    assert(bootstrapAuthorized(` ${generated}\n`) === true, "surrounding whitespace from copy/paste is tolerated");
    assert(bootstrapAuthorized("") === false, "an empty submission never unlocks setup");
    const lines: string[] = [];
    announceSetupToken((l: string) => lines.push(l));
    assert(lines.some((l) => l.includes(generated)), "the generated token is printed at boot");

    process.env.CANOLITE_SETUP_TOKEN = token;
    assert(currentSetupToken() === token, "a configured token takes precedence");
    assert(bootstrapAuthorized(generated) === false, "the generated token stops working once one is configured");
    const quiet: string[] = [];
    announceSetupToken((l: string) => quiet.push(l));
    assert(!quiet.some((l) => l.includes(token)), "an operator-provided token is never echoed to logs");

    process.env.CANOLITE_SETUP_TOKEN = "short";
    assert(currentSetupToken() === generated, "a too-short configured token is ignored");
  } finally {
    if (saved === undefined) delete process.env.CANOLITE_SETUP_TOKEN;
    else process.env.CANOLITE_SETUP_TOKEN = saved;
  }
}

// =============================================================
// Database transport (TLS)
// =============================================================

function databaseTransportTests() {
  console.log("\n🛡️  Database transport");

  const remote = databaseTransport("postgres://u:p@db.example.com:5432/app", {});
  assert(/sslmode=verify-full/.test(remote.libpqUrl), "remote libpq URL requires verified TLS");
  assert(remote.ssl && remote.ssl.rejectUnauthorized === true, "remote runtime connection verifies certificates");
  assert(!/sslmode|sslrootcert/.test(remote.connectionString), "the runtime URL carries no competing TLS options");

  const local = databaseTransport("postgres://u:p@localhost:5432/app", {});
  assert(local.ssl === false, "an embedded loopback connection stays plaintext by default");
  assert(/sslmode=disable/.test(local.libpqUrl), "the local libpq URL is explicit about plaintext");

  const localRequire = databaseTransport("postgres://u:p@localhost:5432/app", { DB_SSL: "require" });
  assert(!!localRequire.ssl && localRequire.ssl.rejectUnauthorized === true, "loopback TLS is honoured when requested");

  const trustedPrivate = databaseTransport("postgres://u:p@10.0.0.5/app", { DB_SSL: "disable" });
  assert(trustedPrivate.ssl === false, "an explicit disable is the only way to reach TLS off remotely");

  const throws = (fn: () => unknown, label: string) => {
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    }
    assert(threw, label);
  };

  throws(() => databaseTransport("postgres://u:p@db.example.com/app?sslmode=disable", {}), "URL sslmode=disable on a remote host is rejected");
  throws(() => databaseTransport("postgres://u:p@db.example.com/app?ssl=true", {}), "competing ssl options in the URL are rejected");
  throws(() => databaseTransport("postgres://u:p@db.example.com/app?host=evil", {}), "host overrides in the URL are rejected");
  throws(() => databaseTransport("postgres://u:p@db.example.com/app", { DB_SSL: "surprise" }), "an unknown DB_SSL mode is rejected");
  throws(() => databaseTransport("mysql://u:p@db/app", {}), "a non-PostgreSQL URL is rejected");
}

// =============================================================
// Render request body limit
// =============================================================

async function renderBodyTests() {
  console.log("\n🛡️  Render request body limit");

  // The route checks Content-Length first, then enforces the same limit while
  // streaming (a chunked request can lie about, or omit, its length). fetch()
  // bodies carry no Content-Length, so both paths are exercised here: one
  // explicit header, and one streamed body counted chunk by chunk.
  const limit = 4 * 1024 * 1024;

  const declared = new Request("https://app.invalid/render", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(limit + 1) },
    body: JSON.stringify({ template_id: "tmpl_1" }),
  });
  assert(
    Number(declared.headers.get("content-length")) > limit,
    "a request may declare an oversized Content-Length"
  );

  const streamed = async (request: Request) => {
    const reader = request.body!.getReader();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        return "rejected";
      }
    }
    return "accepted";
  };

  const tooLarge = new Request("https://app.invalid/render", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(limit + 1),
  });
  assert((await streamed(tooLarge)) === "rejected", "a streamed body over 4 MiB is rejected mid-stream");

  const ok = new Request("https://app.invalid/render", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ template_id: "tmpl_1" }),
  });
  assert((await streamed(ok)) === "accepted", "a normal render request is accepted");
}

// =============================================================
// RESULTS
// =============================================================

async function main() {
  ssrfAddressTests();
  webhookTests();
  bootstrapTests();
  databaseTransportTests();
  await renderBodyTests();

  console.log("\n================================================================");
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log("================================================================");

  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error("Security tests crashed:", error);
  process.exit(1);
});

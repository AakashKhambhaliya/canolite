import { lookup } from "dns/promises";
import net from "net";

/**
 * Best-effort SSRF guard for user-supplied URLs (image sources, webhooks) that
 * the server itself fetches. Rejects non-http(s) schemes and any host that
 * resolves to a loopback / private / link-local / cloud-metadata address.
 *
 * Note: this does not fully defend against DNS rebinding (TOCTOU), but it
 * blocks the common cases (localhost, 10/172.16/192.168, 169.254.169.254, ::1).
 */
function ipToLong(ip: string): number {
  return ip
    .split(".")
    .reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function inRange(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split("/");
  const bits = parseInt(bitsStr, 10);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipToLong(ip) & mask) === (ipToLong(range) & mask);
}

const PRIVATE_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16", // link-local + cloud metadata (169.254.169.254)
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

function isPrivateV4(ip: string): boolean {
  return PRIVATE_V4.some((cidr) => inRange(ip, cidr));
}

function isPrivateV6(ip: string): boolean {
  const a = ip.toLowerCase();
  if (a === "::1" || a === "::") return true;
  if (a.startsWith("fe80") || a.startsWith("fc") || a.startsWith("fd"))
    return true;
  if (a.startsWith("ff")) return true; // multicast
  // IPv4-mapped (::ffff:a.b.c.d)
  const mapped = a.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  return false;
}

const MAX_REDIRECTS = 5;

/**
 * fetch() with the SSRF guard applied to *every* hop of a redirect chain, not
 * just the caller-supplied URL. `fetch(url, { redirect: "follow" })` (or the
 * default) follows redirects itself without re-checking each destination —
 * so a URL that passes isUrlSafe() can still respond with e.g.
 * `302 Location: http://169.254.169.254/...` and the guard never sees the
 * real destination. This fetches with `redirect: "manual"` and validates
 * each Location before following it.
 */
export async function safeFetch(
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await isUrlSafe(current))) {
      throw new Error(`URL is not allowed: ${current}`);
    }
    const res = await fetch(current, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res; // redirect with no Location — nothing to follow
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new Error(`Too many redirects fetching ${url}`);
}

export async function isUrlSafe(raw: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return false;
  }

  let addresses: { address: string; family: number }[];
  const literal = net.isIP(host);
  if (literal) {
    addresses = [{ address: host, family: literal }];
  } else {
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      return false;
    }
  }

  for (const a of addresses) {
    if (a.family === 4 && isPrivateV4(a.address)) return false;
    if (a.family === 6 && isPrivateV6(a.address)) return false;
  }
  return true;
}

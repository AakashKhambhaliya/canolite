/** Outbound transport for user-selected media and webhook destinations. Never
 * hand a validated hostname back to an unconstrained resolver/proxy. */
import { lookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import http from "node:http";
import https from "node:https";

const reserved = new BlockList();
for (const subnet of ["0/8", "10/8", "100.64/10", "127/8", "169.254/16", "172.16/12", "192.0.0/24", "192.0.2/24", "192.88.99/24", "192.168/16", "198.18/15", "198.51.100/24", "203.0.113/24", "224/4", "240/4"]) {
  const [net, bits] = subnet.split("/");
  reserved.addSubnet((net + ".0.0.0").split(".").slice(0, 4).join("."), Number(bits), "ipv4");
}
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [net, bits] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) reserved.addSubnet(net, bits, "ipv6");

export function isPublicAddress(address: string): boolean {
  if (address.includes("%")) return false;
  switch (isIP(address)) {
    case 4: return !reserved.check(address, "ipv4");
    case 6: return globalV6.check(address, "ipv6") && !reserved.check(address, "ipv6");
    default: return false;
  }
}

// Reject promptly on deadline even if the operating system's lookup is slow.
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function publicTarget(url: URL, signal: AbortSignal, resolve = lookup) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || !host || /(?:^|\.)(?:localhost|internal|local)\.?$/i.test(host)) throw new Error("Destination is not public HTTP(S)");
  const family = isIP(host);
  if (!family && !host.includes(".")) throw new Error("A public hostname is required");
  signal.throwIfAborted();
  const addresses = family ? [{ address: host, family }] : await untilAbort(resolve(host, { all: true }), signal);
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address) || a.family !== isIP(a.address))) throw new Error("Destination is not a public address");
  return addresses.find(a => a.family === 4) || addresses[0];
}
export async function isUrlSafe(raw: string): Promise<boolean> {
  try { await publicTarget(new URL(raw), AbortSignal.timeout(5000)); return true; } catch { return false; }
}

export function pinnedLookup(target: {address: string; family: number}): LookupFunction {
  return (_name, options, done) => {
    if (options.all) done(null, [target]);
    else done(null, target.address, target.family);
  };
}

export async function readBounded(stream: AsyncIterable<Uint8Array>, limit: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > limit) throw new Error("Remote response exceeds byte limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

type Options = { maxBytes: number; timeoutMs: number; signal?: AbortSignal; headers?: Record<string,string>; body?: string; allowUrl?: (url: URL) => boolean };
export async function fetchPublic(raw: string, opts: Options) {
  const deadline = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([deadline, opts.signal]) : deadline;
  let url = new URL(raw);
  for (let hop = 0; hop <= 5; hop++) {
    if (opts.allowUrl && !opts.allowUrl(url)) throw new Error("Destination not permitted");
    const target = await publicTarget(url, signal);
    // Use the original hostname for Host, SNI and TLS identity, but ONLY the
    // approved numeric address for the socket. Never reuse an unpinned agent.
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = (url.protocol === "https:" ? https : http).request(url, {
        method: opts.body === undefined ? "GET" : "POST", headers: { ...opts.headers, "Accept-Encoding": "identity" },
        family: target.family, lookup: pinnedLookup(target), agent: false, rejectUnauthorized: true, signal,
      }, resolve);
      request.on("error", reject);
      request.end(opts.body);
    });
    try {
      const status = res.statusCode || 502;
      if (status >= 300 && status < 400 && res.headers.location) {
        // Never forward callback data/signatures, even to another public host.
        if (opts.body !== undefined) throw new Error("Webhook redirects are not accepted");
        url = new URL(res.headers.location, url);
        continue;
      }
      const ok = status >= 200 && status < 300;
      if (!ok || opts.body !== undefined) return { ok, status, headers: res.headers, bytes: Buffer.alloc(0) };
      if (Number(res.headers["content-length"]) > opts.maxBytes) throw new Error("Remote response exceeds byte limit");
      if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") throw new Error("Unexpected response encoding");
      const bytes = await readBounded(res, opts.maxBytes);
      signal.throwIfAborted();
      return { ok, status, headers: res.headers, bytes };
    } finally { res.destroy(); }
  }
  throw new Error("Too many remote redirects");
}

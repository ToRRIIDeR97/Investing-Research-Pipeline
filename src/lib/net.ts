// Network guards shared by web discovery, the structured-data fetchers and the model endpoints:
// which hosts may be reached, how endpoint URLs are validated, and how much of a body is read.
import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";

// Loopback, private, link-local, CGNAT, documentation, benchmarking, multicast and reserved ranges.
// BlockList also matches IPv4-mapped IPv6 (::ffff:127.0.0.1) against the IPv4 rules. Prefixes that
// embed an IPv4 address (SIIT, NAT64, Teredo, 6to4) are blocked whole: they can reach private IPv4.
const nonPublic = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) nonPublic.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96], ["::ffff:0:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) nonPublic.addSubnet(network, prefix, "ipv6");

const unbracket = (host: string) => host.replace(/^\[(.*)\]$/, "$1");

/** True only for an IP address on the public internet. Accepts bracketed IPv6. */
export function isPublicAddress(address: string): boolean {
  const ip = unbracket(address);
  const family = isIP(ip);
  return family !== 0 && !nonPublic.check(ip, family === 6 ? "ipv6" : "ipv4");
}

/** A localhost name or a non-public IP literal. Decides without DNS. */
export function isPrivateHostname(hostname: string): boolean {
  const host = unbracket(hostname.toLowerCase().replace(/\.$/, ""));
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return isIP(host) !== 0 && !isPublicAddress(host);
}

export type HostLookup = (hostname: string) => Promise<string[]>;

const systemLookup: HostLookup = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * A socket lookup that resolves once and hands the socket only addresses that pass `allowed`. Any
 * non-public answer fails the whole lookup, so the address checked is the address connected to.
 */
export function guardedLookup(resolve: HostLookup = systemLookup, allowed = isPublicAddress): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then((addresses) => {
      if (!addresses.length || addresses.some((address) => !allowed(address))) {
        throw new Error(`Refusing host ${hostname}: it resolves to a non-public address`);
      }
      const entries: LookupAddress[] = addresses.map((address) => ({ address, family: isIP(address) }))
        .filter((entry) => !options.family || entry.family === options.family);
      if (!entries.length) throw Object.assign(new Error(`No IPv${options.family} address for ${hostname}`), { code: "ENOTFOUND" });
      if (options.all) callback(null, entries);
      else callback(null, entries[0].address, entries[0].family);
    }).catch((error: NodeJS.ErrnoException) => callback(error, "", 0));
  };
}

/**
 * Builds a fetch whose sockets connect only to public addresses. The connector refuses non-public
 * IP literals (which skip DNS) and resolves names through guardedLookup, so the check and the
 * connection use the same answer. TLS SNI and the Host header still carry the URL's hostname.
 * Every hop, followed redirects included, connects through the same connector.
 */
export function createPublicFetch(
  options: { resolve?: HostLookup; allowed?: (address: string) => boolean } = {}
): typeof fetch {
  const allowed = options.allowed ?? isPublicAddress;
  const connectPublic = buildConnector({ lookup: guardedLookup(options.resolve, allowed) });
  const dispatcher = new Agent({
    connect: (connectOptions, callback) => {
      const host = unbracket(connectOptions.hostname);
      const refused = isIP(host) ? !allowed(host) : isPrivateHostname(host);
      if (refused) callback(new Error(`Refusing non-public host ${connectOptions.hostname}`), null);
      else connectPublic(connectOptions, callback);
    },
  });
  return async (input: string | URL | Request, init?: RequestInit) => {
    if (input instanceof Request) throw new Error("publicFetch takes a URL, not a Request");
    // undici's Response implements the same Fetch API as Node's global one; only the typings differ.
    const response = await undiciFetch(String(input), { ...init, dispatcher } as Parameters<typeof undiciFetch>[1]);
    return response as unknown as Response;
  };
}

const guardedFetch = createPublicFetch();
let testFetch: typeof fetch | undefined;

/** The default fetch for untrusted URLs (web discovery). See createPublicFetch. */
export const publicFetch: typeof fetch = (input, init) => (testFetch ?? guardedFetch)(input, init);

/**
 * Test seam: publicFetch ignores a replaced globalThis.fetch (it has its own dispatcher), so web
 * fixtures route it here instead. Pass undefined to restore the guarded fetch.
 */
export function setPublicFetchForTests(fetchImpl: typeof fetch | undefined) {
  testFetch = fetchImpl;
}

/**
 * Reads a body up to maxBytes after content decoding, then cancels the stream. Content-Length is
 * only checked as a fast path: a compressed or chunked body can be far larger than it says.
 * Throws on overflow, or returns the first maxBytes when truncate is set (whatever Content-Length says).
 */
export async function readCapped(response: Response, maxBytes: number, truncate = false): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = () => new Error(`Response exceeds ${maxBytes} bytes`);
  if (!truncate && Number(response.headers.get("content-length") || 0) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      await reader.cancel().catch(() => undefined);
      if (!truncate) throw tooLarge();
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return Buffer.concat(chunks, total);
}

/**
 * fetch with a timeout that also covers reading the body, and a capped body. The returned
 * Response is fully buffered, so callers keep using ok, status, text() and json().
 */
export async function fetchCapped(
  url: string,
  init: RequestInit = {},
  { timeoutMs = 60_000, maxBytes = 64_000_000 }: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<Response> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const body = await readCapped(response, maxBytes);
  return new Response([204, 205, 304].includes(response.status) ? null : body, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
}

/**
 * Validates a model or embedding endpoint base URL. Remote endpoints need HTTPS and an
 * allowlisted public host; local endpoints (local: true) must be loopback or private.
 * Neither may carry credentials, a query or a fragment.
 */
export function validateEndpointUrl(
  raw: string,
  label: string,
  options: { allowedHosts?: string[]; local?: boolean } = {}
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
  if (url.search || url.hash) throw new Error(`${label} must not contain a query or fragment`);
  if (options.local) {
    if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${label} must use HTTP or HTTPS`);
    if (!isPrivateHostname(url.hostname)) throw new Error(`${label} must use a loopback or private host`);
    return url;
  }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  const allowed = (options.allowedHosts || []).map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(url.hostname.toLowerCase())) {
    throw new Error(`${label} host ${url.hostname} is not allowlisted in RESEARCH_MODEL_ALLOWED_HOSTS`);
  }
  if (isPrivateHostname(url.hostname)) throw new Error(`${label} cannot target a private or loopback host`);
  return url;
}

// Network guards shared by web discovery, the structured-data fetchers and the model endpoints:
// which hosts may be reached, how endpoint URLs are validated, and how much of a body is read.
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// Loopback, private, link-local, CGNAT, documentation, benchmarking, multicast and reserved ranges.
// BlockList also matches IPv4-mapped IPv6 (::ffff:127.0.0.1) against the IPv4 rules.
const nonPublic = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) nonPublic.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
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

/** Throws unless the host and every address it resolves to are public. */
export async function assertPublicHost(hostname: string, resolve: HostLookup = systemLookup): Promise<void> {
  if (isPrivateHostname(hostname)) throw new Error(`Refusing non-public host ${hostname}`);
  const host = unbracket(hostname);
  const addresses = isIP(host) ? [host] : await resolve(host.replace(/\.$/, ""));
  if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) {
    throw new Error(`Refusing host ${hostname}: it resolves to a non-public address`);
  }
}

/**
 * fetch that resolves the target host first and refuses non-public addresses. Use it with
 * redirect: "manual" and call it once per hop, so every redirect target is checked too.
 * The socket does its own lookup, so a DNS answer that changes between the two is not caught.
 */
export const publicFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  await assertPublicHost(url.hostname);
  return fetch(input, init);
};

/**
 * Reads a body up to maxBytes after content decoding, then cancels the stream. Content-Length is
 * only checked as a fast path: a compressed or chunked body can be far larger than it says.
 * Throws on overflow, or returns the first maxBytes when truncate is set.
 */
export async function readCapped(response: Response, maxBytes: number, truncate = false): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = () => new Error(`Response exceeds ${maxBytes} bytes`);
  if (Number(response.headers.get("content-length") || 0) > maxBytes) {
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

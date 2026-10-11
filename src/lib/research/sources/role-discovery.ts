import type { SourceRole } from "./roles";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { htmlToStructuredText } from "@/lib/research/memory/blocks";
import { dropElements, firstElementBody, scanTags, tagAttribute } from "@/lib/html-scan";
import { isPrivateHostname, publicFetch, readCapped } from "@/lib/net";

const execFileAsync = promisify(execFile);

export type RoleDiscoveryContext = {
  assetName: string;
  symbol: string;
  cutoffAt?: string | null;
  seedUrls?: string[];
  roleSeedUrls?: Partial<Record<SourceRole, string[]>>;
  roleQueries?: Partial<Record<SourceRole, string[]>>;
  /** Search only roleQueries: skip seed sites and the generic per-role queries. */
  requestedOnly?: boolean;
};

export type DiscoveredRoleSource = {
  sourceType: string;
  title: string;
  publisher: string;
  url: string;
  content: string;
  mimeType: string;
  qualityScore: string;
  publishedAt?: string | null;
  metadata: Record<string, unknown>;
  chunkTitle: string;
};

type SearchCandidate = {
  url: string;
  title: string;
  snippet?: string;
  query: string;
};

const ROLE_QUERY_TERMS: Record<SourceRole, string[]> = {
  regulatory_filing: ["annual report filing"],
  company_investor_relations: ["investor relations presentation", "investors financial results"],
  earnings_release: ["earnings release results"],
  earnings_presentation: ["earnings presentation investor deck"],
  earnings_transcript: ["earnings call transcript prepared remarks"],
  proxy_and_governance: ["proxy statement corporate governance"],
  founder_and_company_history: ["founder interview company history", "founded origin university archive"],
  peer_company_primary: ["competitor investor relations annual report", "peer company regulatory filing"],
  industry_primary: ["industry regulator report market outlook", "government industry report"],
  customer_or_channel: ["customer project announcement", "customer partnership case study"],
  supplier_or_partner: ["supplier partner announcement", "manufacturing partnership"],
  regulatory_or_government: ["government regulator decision", "government funding award"],
  macro_dataset: ["government economic dataset"],
  market_data: ["historical market data"],
};

const ROLE_LINK_TERMS: Record<SourceRole, RegExp> = {
  regulatory_filing: /(annual|quarterly|10-k|10-q|filing|report)/i,
  company_investor_relations: /(investor|financial|results|presentation|report)/i,
  earnings_release: /(earnings|results|quarter|financial-results|news-release)/i,
  earnings_presentation: /(presentation|earnings-deck|supplement)/i,
  earnings_transcript: /(transcript|prepared-remarks|earnings-call)/i,
  proxy_and_governance: /(proxy|governance|board)/i,
  founder_and_company_history: /(found(?:ed|er|ing)|history|our-story|about|origin|leadership)/i,
  peer_company_primary: /(competitor|peer|investor|annual-report|results|filing|reactor-design|design-cert)/i,
  industry_primary: /(industry|reactor|design|report|outlook|statistics|data)/i,
  customer_or_channel: /(customer|project|case-study|deployment)/i,
  supplier_or_partner: /(supplier|partner|partnership|manufactur)/i,
  regulatory_or_government: /(regulat|approval|decision|award|funding|grant)/i,
  macro_dataset: /(data|dataset|statistics|series)/i,
  market_data: /(historical|market|price|quote)/i,
};

const BLOCKED_HOSTS = [
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "pinterest.com",
  "tiktok.com",
  "x.com",
  "twitter.com",
  "youtube.com",
];

const SEARCH_HOSTS = [
  "bing.com",
  "duckduckgo.com",
  "google.com",
  "search.yahoo.com",
];

// Pages linked from an issuer's IR site are useful company evidence, but they
// cannot establish independent peer, industry, macro, or regulatory coverage.
const ISSUER_SITE_ROLES: SourceRole[] = [
  "company_investor_relations",
  "earnings_release",
  "earnings_presentation",
  "earnings_transcript",
  "proxy_and_governance",
  "founder_and_company_history",
  "customer_or_channel",
  "supplier_or_partner",
];

export function buildRoleSearchQueries(
  assetName: string,
  symbol: string,
  role: SourceRole
): string[] {
  return ROLE_QUERY_TERMS[role].map((term) => `"${assetName}" ${symbol} ${term}`);
}

export function isSafePublicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    // Literal check only; publicFetch resolves DNS before each hop is fetched.
    if (isPrivateHostname(hostname)) return false;
    return !BLOCKED_HOSTS.some((blocked) => hostname === blocked || hostname.endsWith(`.${blocked}`));
  } catch {
    return false;
  }
}

export function isPlausibleSourceRole(urlValue: string, role: SourceRole): boolean {
  try {
    const url = new URL(urlValue);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    if (host === "wikipedia.org" || host.endsWith(".wikipedia.org")) return false;
    if (role !== "market_data" && (
      (host.endsWith("finance.yahoo.com") && /^\/quote\//.test(path)) ||
      (host.endsWith("stockanalysis.com") && /^\/stocks\/[^/]+\/?$/.test(path))
    )) return false;
    if (role === "peer_company_primary" &&
      !(host.endsWith(".gov") || /investor|annual[-_/]?report|financial[-_/]?results|filing|earnings|quarterly/.test(path))) return false;
    if (role === "customer_or_channel" &&
      !/customer|channel|case[-_/]?study|client|partner|testimonial/.test(path)) return false;
    if (role === "supplier_or_partner" &&
      !/supplier|partner|contract|agreement|collaboration|supply/.test(path)) return false;
    if (role === "earnings_release" &&
      !(host.endsWith(".gov") || /earnings|financial[-_/]?results|quarterly[-_/]?results|\/results\/|release|press|news/.test(path))) return false;
    if (role === "regulatory_or_government" && !(host.endsWith(".gov") || host === "gov")) return false;
    return true;
  } catch {
    return false;
  }
}

// Fetched pages are scanned with the linear helpers in html-scan.ts. Backtracking patterns over a
// hostile 1 MB page blocked the worker's event loop, and with it the job lease renewal, for hours.
export function extractPublicLinks(baseUrl: string, html: string): { url: string; text: string }[] {
  const links: { url: string; text: string }[] = [];
  for (const anchor of anchors(html)) {
    const href = decodeHtml(anchor.href);
    if (href.includes("#")) continue;
    try {
      const url = new URL(href, baseUrl).toString();
      if (isSafePublicUrl(url)) links.push({ url, text: anchor.text });
    } catch {
      // Ignore malformed links.
    }
  }
  return links;
}

/** Anchors with an href. Like a browser, an anchor ends at </a> or at the next <a>; one never closed is dropped. */
function anchors(html: string): { href: string; text: string }[] {
  const found: { href: string; text: string }[] = [];
  let open: { href: string; from: number } | null = null;
  for (const tag of scanTags(html)) {
    if (tag.name !== "a") continue;
    if (open) found.push({ href: open.href, text: inlineText(html.slice(open.from, tag.start)) });
    const href = tag.closing ? undefined : tagAttribute(tag, "href");
    open = href ? { href, from: tag.end } : null;
  }
  return found;
}

export function isSubstantiveFetchedContent(content: string, title = ""): boolean {
  return isSubstantiveText(stripHtml(content), title);
}

function isSubstantiveText(raw: string, title: string): boolean {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length < 500 || text.split(/\s+/).length < 80) return false;
  const combined = `${title} ${text.slice(0, 2000)}`.toLowerCase();
  return !/(access denied|captcha|enable javascript|page not found|404 not found)/i.test(combined);
}

export async function discoverRoleSources(
  context: RoleDiscoveryContext,
  roles: SourceRole[],
  fetchImpl: typeof fetch = publicFetch
): Promise<DiscoveredRoleSource[]> {
  if (process.env.RESEARCH_TEST_MODE === "1" || process.env.RESEARCH_ACCEPTANCE_PROVIDER === "mock") {
    return [];
  }
  if (process.env.RESEARCH_WEB_DISCOVERY_ENABLED === "0") return [];

  const maxPerRole = positiveInteger(process.env.RESEARCH_WEB_DISCOVERY_MAX_PER_ROLE, 2);
  const maxRoles = positiveInteger(process.env.RESEARCH_WEB_DISCOVERY_MAX_ROLES, 8);
  const selectedRoles = [...new Set(roles)].slice(0, maxRoles);
  const seedCandidates = context.requestedOnly ? new Map<SourceRole, SearchCandidate[]>() : await discoverSeedCandidates(
    context.seedUrls || [],
    selectedRoles.filter((role) => ISSUER_SITE_ROLES.includes(role)),
    fetchImpl,
    context.assetName
  );
  for (const [role, urls] of (context.requestedOnly ? [] : Object.entries(context.roleSeedUrls || {})) as [SourceRole, string[]][]) {
    if (!selectedRoles.includes(role)) continue;
    const explicitCandidates = (urls || [])
      .map((value) => normalizeSeedUrl(value))
      .filter((value): value is string => Boolean(value))
      .map((url) => ({
        url,
        title: new URL(url).hostname,
        query: `"${context.assetName}" explicit-role-seed:${role}`,
      }));
    // A role seed is an operator assertion about both the URL and its intended
    // evidentiary purpose, so it must be attempted before heuristic candidates.
    seedCandidates.set(role, [...explicitCandidates, ...(seedCandidates.get(role) || [])]);
  }
  const discovered: DiscoveredRoleSource[] = [];

  for (const role of selectedRoles) {
    const candidates = seedCandidates.get(role) || [];
    const requested = context.roleQueries?.[role] || [];
    const queries = [...requested, ...(context.requestedOnly ? [] : buildRoleSearchQueries(context.assetName, context.symbol, role))];
    // Each targeted query names a distinct document, so each may contribute one.
    const roleLimit = context.requestedOnly ? Math.min(4, Math.max(maxPerRole, requested.length)) : maxPerRole;
    // Requested queries go first, in the order they were asked.
    let requestedEnd = 0;
    for (const query of queries) {
      if (!requested.includes(query) && candidates.length >= maxPerRole * 3) break;
      const found = await searchWeb(query, fetchImpl);
      if (requested.includes(query)) {
        candidates.splice(requestedEnd, 0, ...found);
        requestedEnd += found.length;
      } else candidates.push(...found);
    }

    for (const candidate of dedupeCandidates(candidates)) {
      if (discovered.filter((source) => source.metadata.source_role === role).length >= roleLimit) break;
      if (context.requestedOnly && discovered.some((source) => source.metadata.discovery_query === candidate.query)) continue;
      // A named peer's own filing need not mention the researched company.
      const identity = role === "peer_company_primary" && requested.includes(candidate.query) ? "" : context.assetName;
      const source = await fetchCandidate(candidate, role, context.cutoffAt, identity, fetchImpl);
      if (!source) continue;
      discovered.push(source);
      if (role === "company_investor_relations" && isIssuerSeedSite(source.url, context.seedUrls || [])) {
        const issuerRoles = selectedRoles.filter(
          (selectedRole) => selectedRole !== role && ISSUER_SITE_ROLES.includes(selectedRole)
        );
        if (issuerRoles.length === 0) continue;
        const issuerSiteCandidates = await discoverSeedCandidates(
          [source.url],
          issuerRoles,
          fetchImpl,
          context.assetName
        );
        for (const [selectedRole, additions] of issuerSiteCandidates.entries()) {
          seedCandidates.set(selectedRole, [
            ...(seedCandidates.get(selectedRole) || []),
            ...additions,
          ]);
        }
      }
    }
  }
  return discovered;
}

async function discoverSeedCandidates(
  seedUrls: string[],
  roles: SourceRole[],
  fetchImpl: typeof fetch,
  assetName = ""
): Promise<Map<SourceRole, SearchCandidate[]>> {
  const result = new Map<SourceRole, SearchCandidate[]>();
  const normalizedSeeds = seedUrls
    .map((value) => normalizeSeedUrl(value))
    .filter((value): value is string => Boolean(value));
  for (const seed of [...new Set(normalizedSeeds)].slice(0, 4)) {
    const response = await safeFetch(seed, fetchImpl).catch(() => null);
    if (!response?.ok) continue;
    const type = response.headers.get("content-type") || "";
    if (!type.includes("html")) continue;
    const links = extractPublicLinks(response.url || seed, await boundedText(response));
    for (const role of roles) {
      const matching = links
        .filter((link) => ROLE_LINK_TERMS[role].test(`${link.text} ${link.url}`))
        .slice(0, 8)
        .map((link) => ({
          url: link.url,
          title: link.text || new URL(link.url).hostname,
          query: `issuer-site:${seed}`,
        }));
      if (matching.length) result.set(role, [...(result.get(role) || []), ...matching]);
    }
  }
  return result;
}

function normalizeSeedUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return isSafePublicUrl(normalized) ? normalized : null;
}

function isIssuerSeedSite(sourceUrl: string, seedUrls: string[]): boolean {
  try {
    const sourceHost = new URL(sourceUrl).hostname.toLowerCase();
    return seedUrls.some((seed) => {
      const normalized = normalizeSeedUrl(seed);
      if (!normalized) return false;
      const seedHost = new URL(normalized).hostname.toLowerCase();
      return sourceHost === seedHost || sourceHost.endsWith(`.${seedHost}`) || seedHost.endsWith(`.${sourceHost}`);
    });
  } catch {
    return false;
  }
}

async function searchWeb(query: string, fetchImpl: typeof fetch): Promise<SearchCandidate[]> {
  const endpoint = process.env.RESEARCH_WEB_SEARCH_ENDPOINT;
  if (endpoint) {
    const url = new URL(endpoint);
    // The key travels in headers, so never in cleartext (#22).
    if (url.protocol !== "https:") throw new Error("RESEARCH_WEB_SEARCH_ENDPOINT must use HTTPS");
    url.searchParams.set("q", query);
    const headers: Record<string, string> = { Accept: "application/json" };
    const apiKey = process.env.RESEARCH_WEB_SEARCH_API_KEY;
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
      headers["Ocp-Apim-Subscription-Key"] = apiKey;
    }
    const response = await safeFetch(url.toString(), fetchImpl, headers);
    if (!response.ok) return [];
    const payload = JSON.parse(new TextDecoder().decode(await readCapped(response, 1_000_000)));
    return parseSearchPayload(payload, query);
  }

  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await safeFetch(url, fetchImpl);
  const html = response.ok ? await boundedText(response) : "";
  const duckDuckGoCandidates = extractPublicLinks(url, html)
    .map((link) => ({
      url: unwrapDuckDuckGoUrl(link.url),
      title: link.text,
      query,
    }))
    .filter((candidate) => isSafePublicUrl(candidate.url))
    .filter((candidate) => !/duckduckgo\.com/i.test(new URL(candidate.url).hostname))
    .slice(0, 10);
  if (duckDuckGoCandidates.length > 0) return duckDuckGoCandidates;
  if (process.env.RESEARCH_BING_HTML_FALLBACK !== "1") return [];

  const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  const bingResponse = await safeFetch(bingUrl, fetchImpl);
  if (!bingResponse.ok) return [];
  return parseBingHtml(await boundedText(bingResponse), query);
}

/** The first linked heading of each `li.b_algo` result. */
export function parseBingHtml(html: string, query: string): SearchCandidate[] {
  const candidates: SearchCandidate[] = [];
  let state: "outside" | "result" | "heading" = "outside";
  let link: { href: string; from: number } | null = null;
  for (const tag of scanTags(html)) {
    if (link && tag.name === "a") {
      const url = unwrapBingUrl(decodeHtml(link.href));
      if (isAcceptableSourceUrl(url)) candidates.push({ url, title: inlineText(html.slice(link.from, tag.start)), query });
      link = null;
      state = "outside";
    }
    if (tag.closing) continue;
    if (tag.name === "li") state = /\bb_algo\b/.test(tagAttribute(tag, "class") || "") ? "result" : "outside";
    else if (tag.name === "h2" && state === "result") state = "heading";
    else if (tag.name === "a" && state === "heading") {
      const href = tagAttribute(tag, "href");
      if (href) link = { href, from: tag.end };
    }
  }
  return dedupeCandidates(candidates).slice(0, 10);
}

export function parseSearchPayload(payload: unknown, query: string): SearchCandidate[] {
  const record = asRecord(payload);
  const webPages = asRecord(record.webPages);
  const arrays = [
    Array.isArray(record.results) ? record.results : [],
    Array.isArray(record.items) ? record.items : [],
    Array.isArray(webPages.value) ? webPages.value : [],
  ];
  return arrays.flat().map((item) => {
    const value = asRecord(item);
    return {
      url: String(value.url || value.link || ""),
      title: String(value.title || value.name || ""),
      snippet: String(value.snippet || value.description || ""),
      query,
    };
  }).filter((candidate) => isAcceptableSourceUrl(candidate.url) && candidate.title.trim());
}

async function fetchCandidate(
  candidate: SearchCandidate,
  role: SourceRole,
  cutoffAt: string | null | undefined,
  assetName: string,
  fetchImpl: typeof fetch
): Promise<DiscoveredRoleSource | null> {
  try {
    if (!isPlausibleSourceRole(candidate.url, role)) return null;
    const response = await safeFetch(candidate.url, fetchImpl);
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "";
    let content: string;
    let storedMimeType = contentType.split(";")[0] || "text/html";
    let extractionMethod = "response_text";
    if (/pdf/i.test(contentType) || /\.pdf(?:$|\?)/i.test(candidate.url)) {
      content = await extractPdfText(await boundedBytes(response));
      storedMimeType = "text/plain";
      extractionMethod = "pdftotext";
    } else {
      if (!/(html|text|json|xml)/i.test(contentType)) return null;
      content = await boundedText(response);
    }
    const title = extractTitle(content) || candidate.title;
    // Strip once; the substance and relevance checks share the text.
    const text = stripHtml(content);
    if (!isSubstantiveText(text, title)) return null;
    const explicitRoleSeed = candidate.query.includes(`explicit-role-seed:${role}`);
    if (!isRelevantForRole(
      text,
      title,
      candidate.url,
      role,
      explicitRoleSeed ? "" : assetName
    )) {
      return null;
    }
    const metaPublishedAt = extractPublishedAt(content);
    // SEC filing documents carry no date tags; the EDGAR filing index states the filing date.
    const publishedAt = metaPublishedAt ?? await secFilingDate(response.url || candidate.url, fetchImpl);
    if (publishedAt && cutoffAt && new Date(publishedAt) > new Date(cutoffAt)) return null;
    if (/html/i.test(contentType)) {
      const article = firstElementBody(content, "article");
      const html = article && isSubstantiveFetchedContent(article, title) ? article : content;
      // Keep headings and paragraphs so stored pages can be split into sections later.
      content = htmlToStructuredText(html);
      storedMimeType = "text/plain";
      extractionMethod = "html_structured_text";
    }
    const finalUrl = response.url || candidate.url;
    if (!isPlausibleSourceRole(finalUrl, role)) return null;
    return {
      sourceType: roleSourceType(role),
      title,
      publisher: new URL(finalUrl).hostname,
      url: finalUrl,
      content,
      mimeType: storedMimeType,
      qualityScore: sourceQuality(finalUrl),
      publishedAt,
      metadata: {
        system_generated: true,
        source: "role_driven_web_discovery",
        source_role: role,
        discovery_query: candidate.query,
        fetch_status: "fetched",
        substantive: true,
        original_mime_type: contentType.split(";")[0] || null,
        extraction_method: extractionMethod,
        point_in_time_status: metaPublishedAt ? "verified_publication_date" : publishedAt ? "sec_filing_date" : "publication_date_unknown",
      },
      chunkTitle: title,
    };
  } catch {
    return null;
  }
}

/** Follows up to 3 redirects, checking each hop. `credentials` go to the first hop only. */
async function safeFetch(
  value: string,
  fetchImpl: typeof fetch,
  credentials: Record<string, string> = {}
): Promise<Response> {
  let current = value;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (!isSafePublicUrl(current)) throw new Error("Unsafe discovery URL");
    const response = await fetchImpl(current, {
      redirect: "manual",
      headers: {
        "User-Agent": "ResearchOS/0.3 role-driven-source-discovery research-pipeline@example.com",
        ...(redirects === 0 ? credentials : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    await response.body?.cancel().catch(() => undefined);
    current = new URL(location, current).toString();
  }
  throw new Error("Too many redirects");
}

/** The first 1 MB of a decoded body. */
async function boundedText(response: Response): Promise<string> {
  return new TextDecoder().decode(await readCapped(response, 1_000_000, true));
}

async function boundedBytes(response: Response): Promise<Uint8Array> {
  return readCapped(response, 10_000_000);
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "research-os-source-"));
  const path = join(directory, "source.pdf");
  try {
    await writeFile(path, bytes);
    const { stdout } = await execFileAsync("pdftotext", ["-layout", path, "-"], {
      timeout: 20_000,
      maxBuffer: 2_000_000,
    });
    return stdout.slice(0, 1_000_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** The EDGAR filing index page for a document under /Archives/edgar/data/<cik>/<accession>/. */
export function secFilingIndexUrl(url: string): string | null {
  const match = url.match(/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/(\d+)\/(\d{18})\//i);
  if (!match) return null;
  const [, cik, accession] = match;
  const dashed = `${accession.slice(0, 10)}-${accession.slice(10, 12)}-${accession.slice(12)}`;
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${accession}/${dashed}-index.htm`;
}

export function parseSecFilingDate(indexHtml: string): string | null {
  const date = indexHtml.match(/Filing Date<\/div>\s*<div[^>]*class=["']info["'][^>]*>\s*(\d{4}-\d{2}-\d{2})\s*</i)?.[1];
  return date ? new Date(`${date}T00:00:00Z`).toISOString() : null;
}

export async function secFilingDate(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  const indexUrl = secFilingIndexUrl(url);
  if (!indexUrl) return null;
  try {
    const response = await safeFetch(indexUrl, fetchImpl);
    return response.ok ? parseSecFilingDate(await boundedText(response)) : null;
  } catch {
    return null;
  }
}

/** A date meta tag, then JSON-LD datePublished, then the first <time datetime>. */
function extractPublishedAt(content: string): string | null {
  const dateMeta = /^(?:article:published_time|date|datePublished)$/i;
  let meta: string | undefined;
  let time: string | undefined;
  for (const tag of scanTags(content)) {
    if (tag.closing) continue;
    if (!meta && tag.name === "meta" &&
      (dateMeta.test(tagAttribute(tag, "property") || "") || dateMeta.test(tagAttribute(tag, "name") || ""))) {
      meta = tagAttribute(tag, "content");
    } else if (!time && tag.name === "time") time = tagAttribute(tag, "datetime");
    if (meta && time) break;
  }
  for (const value of [meta, content.match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1], time]) {
    if (!value) continue;
    const date = new Date(decodeHtml(value));
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

function extractTitle(content: string): string {
  return inlineText(firstElementBody(content, "title") || "").slice(0, 300);
}

function roleSourceType(role: SourceRole): string {
  return `web_${role}`;
}

function sourceQuality(value: string): string {
  const host = new URL(value).hostname.toLowerCase();
  if (host.endsWith(".gov") || host.endsWith(".edu")) return "0.94";
  if (host.includes("investor") || host.includes("ir.")) return "0.90";
  return "0.82";
}

function dedupeCandidates(candidates: SearchCandidate[]): SearchCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const normalized = candidate.url.replace(/#.*$/, "").replace(/\/$/, "");
    if (!isAcceptableSourceUrl(normalized) || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function isAcceptableSourceUrl(value: string): boolean {
  if (!isSafePublicUrl(value)) return false;
  const hostname = new URL(value).hostname.toLowerCase();
  return !SEARCH_HOSTS.some((searchHost) => hostname === searchHost || hostname.endsWith(`.${searchHost}`));
}

function unwrapDuckDuckGoUrl(value: string): string {
  try {
    const url = new URL(value);
    const target = url.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : value;
  } catch {
    return value;
  }
}

function unwrapBingUrl(value: string): string {
  try {
    const url = new URL(decodeHtml(value));
    if (!/(^|\.)bing\.com$/i.test(url.hostname)) return value;
    const encoded = url.searchParams.get("u");
    if (!encoded?.startsWith("a1")) return value;
    const decoded = Buffer.from(encoded.slice(2), "base64url").toString("utf8");
    return isSafePublicUrl(decoded) ? decoded : value;
  } catch {
    return value;
  }
}

/** `text` is the page's already-extracted text; only its first 20,000 characters are searched. */
function isRelevantForRole(
  text: string,
  title: string,
  url: string,
  role: SourceRole,
  assetName: string
): boolean {
  const searchable = `${title} ${url} ${text.slice(0, 20_000)}`.toLowerCase();
  if (["customer_or_channel", "supplier_or_partner"].includes(role) && assetName) {
    const identity = `${title} ${url}`.toLowerCase();
    const tokens = assetName.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4);
    if (tokens.length && !tokens.some((token) => identity.includes(token))) return false;
  }
  if (!["macro_dataset", "market_data"].includes(role)) {
    const genericCompanyTokens = new Set([
      "company", "corporation", "corp", "inc", "limited", "ltd", "plc",
      "group", "holding", "holdings", "technology", "technologies", "power", "energy",
    ]);
    const tokens = assetName.toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4 && !genericCompanyTokens.has(token));
    if (tokens.length > 0 && !tokens.some((token) => searchable.includes(token))) return false;
  }
  return ROLE_LINK_TERMS[role].test(searchable);
}

function stripHtml(value: string): string {
  return decodeHtml(dropElements(value, ["script", "style"]).replace(/<[^<>]*>/g, " "));
}

function inlineText(value: string): string {
  return stripHtml(value).replace(/\s+/g, " ").trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

// Company profiles: a researched company's logo, website and leadership (with photos), from Wikidata and the English
// Wikipedia infobox. Free, keyless, display only: never a report input. Everything read here is untrusted. Names and
// roles are stripped to plain text, and image URLs are rebuilt (Commons file names) or allow-listed (Wikimedia hosts),
// so a hostile value can't put a script, another host or a tracking query into an <img src>.

export interface CompanySubject { name: string; ticker?: string | null; kind?: string | null }
export interface CompanyPerson { name: string; role: string; photo_url: string | null; page_url: string | null }
export interface CompanyProfile {
  key: string;
  name: string;
  wikidata_id: string | null;
  logo_url: string | null;
  website: string | null;
  wikipedia_url: string | null;
  people: CompanyPerson[];
}
export type FetchJson = (url: string) => Promise<unknown>;

const WIKIDATA = "https://www.wikidata.org/w/api.php";
const WIKIPEDIA = "https://en.wikipedia.org/w/api.php";
const IMAGE_HOSTS = new Set(["upload.wikimedia.org", "thumb.wikimedia.org", "commons.wikimedia.org"]);
const MAX_PEOPLE = 6;

type Json = Record<string, any>;
const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};

/** Drops legal suffixes and test markers so "SoFi Technologies, Inc. (Test)" searches as "SoFi Technologies". */
export function cleanCompanyName(name: string): string {
  return name
    .replace(/\((?:test|fixture|e2e)[^)]*\)/gi, "")
    .replace(/,?\s+\b(?:inc|incorporated|corp|corporation|co|company|ltd|limited|plc|llc|l\.?p|n\.?v|s\.?a|ag|se|holdings?)\b\.?\s*$/i, "")
    .replace(/,?\s+\b(?:inc|corp|ltd|plc|llc)\b\.?\s*$/i, "")
    .replace(/[\s,]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

const tickerForm = (ticker: string) => ticker.trim().toUpperCase().replace(/\./g, "-");

/** The cache key: the ticker when there is one, else the cleaned lower-case name. */
export function profileKey(subject: { name: string; ticker?: string | null }): string {
  const ticker = subject.ticker?.trim();
  return ticker ? `ticker:${ticker.toUpperCase()}` : `name:${cleanCompanyName(subject.name).toLowerCase()}`;
}

/** A Commons file name as a resized image URL, or null when the name could reach anything else. */
export function commonsFileUrl(file: unknown, width = 256): string | null {
  if (typeof file !== "string") return null;
  const name = file.trim().replace(/^(?:File|Image):/i, "").replace(/_/g, " ");
  if (!name || name.length > 240 || /[\\/#?]|\.\.|[\u0000-\u001f\u007f]/.test(name)) return null;
  if (!/\.(?:svg|png|jpe?g|gif|webp)$/i.test(name)) return null;
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=${width}`;
}

/** An https Wikimedia image URL without its query string, or null. */
export function safeImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !IMAGE_HOSTS.has(url.hostname) || url.username || url.password || url.port) return null;
    return `${url.origin}${url.pathname}`;
  } catch { return null; }
}

function safeWebsite(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------------------------------------------
// Infobox parsing

/** The value of one infobox field, braces balanced, or null. */
function infoboxField(wikitext: string, names: string[]): string | null {
  const re = new RegExp(`^\\s*\\|\\s*(?:${names.join("|")})\\s*=`, "im");
  const match = re.exec(wikitext);
  if (!match) return null;
  let depth = 0;
  let i = match.index + match[0].length;
  const start = i;
  for (; i < wikitext.length; i++) {
    const two = wikitext.slice(i, i + 2);
    if (two === "{{" || two === "[[") { depth++; i++; continue; }
    if (two === "}}" || two === "]]") { if (depth === 0) break; depth--; i++; continue; }
    if (depth === 0 && wikitext[i] === "\n" && /^\n\s*(?:\||\}\})/.test(wikitext.slice(i, i + 4))) break;
  }
  return wikitext.slice(start, i);
}

/** Splits a list field ({{ubl|a|b}}, {{plainlist|* a * b}}, <br>, bullets) into its items, links kept. */
function listItems(value: string): string[] {
  let text = value
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  // Protect pipes inside links, then unwrap list templates.
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "[[$1\u0001$2]]");
  text = text.replace(/\{\{\s*(?:ubl|unbulleted list|plainlist|flatlist|collapsible list|hlist|bulleted list|ublist)\s*/gi, "{{LIST");
  const items: string[] = [];
  const push = (part: string) => { const t = part.trim(); if (t) items.push(t); };
  const parts = text.split(/<br\s*\/?>|\n\s*\*|\n/i);
  for (const part of parts) {
    if (/\{\{LIST/.test(part)) {
      const inner = part.replace(/\{\{LIST/, "").replace(/\}\}\s*$/, "");
      for (const item of inner.split("|")) if (!/^\s*title\s*=/.test(item)) push(item.replace(/^\s*\*/, ""));
    } else push(part.replace(/^\s*\*/, "").replace(/\}\}\s*$/, ""));
  }
  return items.map((item) => item.replace(/\u0001/g, "|"));
}

/** Plain text from wiki markup: links become their label, templates and HTML go. */
function plain(value: string): string {
  return value
    .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/'{2,}/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/[{}[\]|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface InfoboxPerson { name: string; role: string; title: string | null }

function personFrom(item: string, fallbackRole: string): InfoboxPerson | null {
  const roleMatch = /\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/.exec(item.replace(/\{\{[^{}]*\}\}\s*$/, "").trim());
  const role = roleMatch ? plain(roleMatch[1]) : "";
  const head = roleMatch ? item.slice(0, item.lastIndexOf(roleMatch[0])) : item;
  const link = /\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/.exec(head);
  const name = plain(link ? (link[2] ?? link[1]) : head);
  if (!name || name.length > 80 || /^(?:and|others|see below)$/i.test(name) || /\d{3,}/.test(name)) return null;
  return { name, role: role && role.length <= 60 ? role : fallbackRole, title: link ? link[1].trim() : null };
}

/** Key people (with their roles) then founders, from the infobox of a company article. */
export function parseInfoboxPeople(wikitext: string): InfoboxPerson[] {
  const people: InfoboxPerson[] = [];
  const key = infoboxField(wikitext, ["key_people", "key people"]);
  if (key) for (const item of listItems(key)) { const p = personFrom(item, "Executive"); if (p) people.push(p); }
  const founders = infoboxField(wikitext, ["founders", "founder"]);
  if (founders) {
    const items = listItems(founders).map((item) => personFrom(item.replace(/\([^)]*\)\s*$/, ""), "Founder")).filter((p): p is InfoboxPerson => !!p);
    const role = items.length > 1 ? "Co-founder" : "Founder";
    for (const p of items) people.push({ ...p, role });
  }
  return people;
}

function infoboxLogo(wikitext: string): string | null {
  const logo = infoboxField(wikitext, ["logo"]);
  if (!logo) return null;
  const file = /(?:\[\[(?:File|Image):)?([^|\]\n]+\.(?:svg|png|jpe?g|gif|webp))/i.exec(logo);
  return file ? commonsFileUrl(file[1]) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Wikidata

const claimValues = (entity: Json, property: string): unknown[] => {
  const claims: Json[] = Array.isArray(entity.claims?.[property]) ? entity.claims[property] : [];
  const usable = claims.filter((c) => c.rank !== "deprecated" && !(Array.isArray(c.qualifiers?.P582) && c.qualifiers.P582.length));
  const ranked = usable.some((c) => c.rank === "preferred") ? usable.filter((c) => c.rank === "preferred") : usable;
  return ranked.map((c) => c.mainsnak?.datavalue?.value).filter((v) => v != null);
};
const itemIds = (entity: Json, property: string) => claimValues(entity, property).map((v) => record(v).id).filter((id): id is string => typeof id === "string" && /^Q\d+$/.test(id));

function listsTicker(entity: Json, ticker: string): boolean {
  const want = tickerForm(ticker);
  const claims: Json[] = Array.isArray(entity.claims?.P414) ? entity.claims.P414 : [];
  return claims.some((c) => (Array.isArray(c.qualifiers?.P249) ? c.qualifiers.P249 : [])
    .some((q: Json) => typeof q?.datavalue?.value === "string" && tickerForm(q.datavalue.value) === want));
}

const url = (base: string, params: Record<string, string>) => `${base}?${new URLSearchParams({ format: "json", ...params })}`;
const wikiUrl = (title: string) => `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_")).replace(/%2F/g, "/")}`;

/**
 * Resolves a company's profile. With a ticker, only an entity listing that ticker is accepted (no wrong logo for a
 * namesake); without one, the first candidate whose label matches the cleaned name. Returns null when nothing matches.
 */
export async function resolveCompanyProfile(subject: CompanySubject, fetchJson: FetchJson): Promise<CompanyProfile | null> {
  const name = cleanCompanyName(subject.name);
  if (!name) return null;
  const search = record(await fetchJson(url(WIKIDATA, { action: "wbsearchentities", search: name, language: "en", type: "item", limit: "7" })));
  const ids = (Array.isArray(search.search) ? search.search : []).map((r: Json) => r?.id).filter((id: unknown): id is string => typeof id === "string" && /^Q\d+$/.test(id));
  if (!ids.length) return null;
  const got = record(await fetchJson(url(WIKIDATA, { action: "wbgetentities", ids: ids.join("|"), props: "claims|labels|sitelinks", languages: "en", sitefilter: "enwiki" })));
  const entities = record(got.entities);
  const candidates = ids.map((id: string) => record(entities[id])).filter((e: Json) => e.id);
  const label = (e: Json) => String(e.labels?.en?.value ?? "");
  const entity = subject.ticker
    ? candidates.find((e: Json) => listsTicker(e, subject.ticker!))
    : candidates.find((e: Json) => label(e).toLowerCase() === name.toLowerCase());
  if (!entity) return null;

  const title: string | null = typeof entity.sitelinks?.enwiki?.title === "string" ? entity.sitelinks.enwiki.title : null;
  let logo = commonsFileUrl(claimValues(entity, "P154")[0]);
  let people: InfoboxPerson[] = [];
  if (title) {
    const page = record(await fetchJson(url(WIKIPEDIA, { action: "query", prop: "revisions", rvprop: "content", rvslots: "main", rvsection: "0", titles: title, formatversion: "2", redirects: "1" })));
    const wikitext = page.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content;
    if (typeof wikitext === "string") {
      people = parseInfoboxPeople(wikitext);
      logo ??= infoboxLogo(wikitext);
    }
  }

  // De-duplicate by name, keep the first (key people before founders), cap.
  const seen = new Set<string>();
  people = people.filter((p) => { const k = p.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, MAX_PEOPLE);

  let result: CompanyPerson[];
  if (people.length) {
    const titles = [...new Set(people.map((p) => p.title).filter((t): t is string => !!t))];
    const photos = new Map<string, string>();
    if (titles.length) {
      const images = record(await fetchJson(url(WIKIPEDIA, { action: "query", prop: "pageimages", piprop: "thumbnail", pithumbsize: "240", titles: titles.join("|"), formatversion: "2", redirects: "1" })));
      for (const page of Array.isArray(images.query?.pages) ? images.query.pages : []) {
        const src = safeImageUrl(page?.thumbnail?.source);
        if (typeof page?.title === "string" && src) photos.set(page.title, src);
      }
      for (const r of Array.isArray(images.query?.redirects) ? images.query.redirects : []) {
        if (typeof r?.from === "string" && typeof r?.to === "string" && photos.has(r.to)) photos.set(r.from, photos.get(r.to)!);
      }
    }
    result = people.map((p) => ({ name: p.name, role: p.role, photo_url: p.title ? photos.get(p.title) ?? null : null, page_url: p.title ? wikiUrl(p.title) : null }));
  } else {
    // No infobox people: Wikidata's CEO, founders and chair.
    const roles: [string, string][] = [];
    for (const id of itemIds(entity, "P169")) roles.push([id, "CEO"]);
    const founders = itemIds(entity, "P112");
    for (const id of founders) roles.push([id, founders.length > 1 ? "Co-founder" : "Founder"]);
    for (const id of itemIds(entity, "P488")) roles.push([id, "Chair"]);
    const unique = roles.filter(([id], i) => roles.findIndex(([other]) => other === id) === i).slice(0, MAX_PEOPLE);
    result = [];
    if (unique.length) {
      const peopleData = record(record(await fetchJson(url(WIKIDATA, { action: "wbgetentities", ids: unique.map(([id]) => id).join("|"), props: "claims|labels|sitelinks", languages: "en", sitefilter: "enwiki" }))).entities);
      for (const [id, role] of unique) {
        const person = record(peopleData[id]);
        const personName = plain(String(person.labels?.en?.value ?? ""));
        if (!personName) continue;
        const page: string | null = typeof person.sitelinks?.enwiki?.title === "string" ? person.sitelinks.enwiki.title : null;
        result.push({ name: personName, role, photo_url: commonsFileUrl(claimValues(person, "P18")[0]), page_url: page ? wikiUrl(page) : null });
      }
    }
  }

  return {
    key: profileKey(subject),
    name: label(entity) || name,
    wikidata_id: String(entity.id),
    logo_url: logo,
    website: safeWebsite(claimValues(entity, "P856")[0]),
    wikipedia_url: title ? wikiUrl(title) : null,
    people: result,
  };
}

/** Wikimedia asked this process to wait (429/503 with Retry-After): nothing is cached, the lookup is retried later. */
export class RateLimitedError extends Error {
  constructor(public readonly until: number) { super(`Wikimedia rate limit: retry after ${new Date(until).toISOString()}`); }
}

// Wikimedia's API rate limits (2026): a User-Agent without contact details is "unidentified", 10 requests a minute;
// one with contact details (WIKIMEDIA_CONTACT, an operator-set URL or address) is allowed 200. Requests go one at a
// time, spaced to stay under the limit, and a 429 pauses every lookup until its Retry-After.
const limiter = { tail: Promise.resolve() as Promise<unknown>, last: 0, blockedUntil: 0 };
const contact = () => process.env.WIKIMEDIA_CONTACT?.trim().replace(/[^\w@.:/+~-]/g, "").slice(0, 120) || "";
export const wikimediaUserAgent = () => `PragmaResearch/1.0 (${contact() || "self-hosted research tool"}) undici`;
/** True when WIKIMEDIA_CONTACT holds a usable value, so lookups count as identified (200 requests a minute). */
export const wikimediaIdentified = () => contact() !== "";
/** The gap between two Wikimedia requests: under 10 a minute unidentified, under 200 a minute identified. */
export const wikimediaSpacingMs = () => wikimediaIdentified() ? 400 : 6_500;

/**
 * A notice that logs one server line, once per process, the first time lookups run unidentified. It names the
 * setting and the operations doc, never a value from the environment.
 */
export function createUnidentifiedNotice(log: (line: string) => void = (line) => console.warn(line)) {
  let shown = false;
  return () => {
    if (shown || wikimediaIdentified()) return;
    shown = true;
    log("[company-profiles] Wikimedia lookups are unidentified: WIKIMEDIA_CONTACT is not set (or has no usable characters), "
      + "so requests are spaced 6.5 s apart (Wikimedia allows 10 a minute) and a new company's logo takes about 30 s. "
      + "Set WIKIMEDIA_CONTACT in .env.local to a URL or address of your own to allow 200 a minute; "
      + "see docs/operations.md#company-profiles-logos-and-leadership.");
  };
}
const unidentifiedNotice = createUnidentifiedNotice();

/**
 * The live fetcher: fixed Wikimedia API hosts, a User-Agent with no operator details unless WIKIMEDIA_CONTACT is set,
 * one request at a time, timeouts, no redirects and a size cap. It uses undici's plain request: Wikipedia answers 429
 * to the global fetch, whose browser-style Sec-Fetch and Accept-Language headers its bot filter rejects.
 */
export async function wikimediaFetchJson(target: string): Promise<unknown> {
  const host = new URL(target).hostname;
  if (host !== "www.wikidata.org" && host !== "en.wikipedia.org") throw new Error(`Refusing host ${host}`);
  unidentifiedNotice();
  const turn = limiter.tail.then(async () => {
    if (Date.now() < limiter.blockedUntil) throw new RateLimitedError(limiter.blockedUntil);
    const wait = limiter.last + wikimediaSpacingMs() - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    limiter.last = Date.now();
  });
  limiter.tail = turn.catch(() => {});
  await turn;
  const { request } = await import("undici");
  const response = await request(target, {
    headers: { "user-agent": wikimediaUserAgent(), accept: "application/json" },
    headersTimeout: 8_000, bodyTimeout: 8_000,
  });
  if (response.statusCode === 429 || response.statusCode === 503) {
    await response.body.dump();
    const header = Number(response.headers["retry-after"]);
    limiter.blockedUntil = Date.now() + Math.max(60, Number.isFinite(header) ? header : 0) * 1000;
    throw new RateLimitedError(limiter.blockedUntil);
  }
  if (response.statusCode !== 200) { await response.body.dump(); throw new Error(`${host} answered ${response.statusCode}`); }
  let text = "";
  for await (const chunk of response.body) {
    text += chunk;
    if (text.length > 2_000_000) { response.body.destroy(); throw new Error(`${host} response too large`); }
  }
  return JSON.parse(text);
}

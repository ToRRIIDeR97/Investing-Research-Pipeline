// Wikidata and Wikipedia responses shaped like the live APIs (checked on 2026-11-22), trimmed to what the resolver reads.
const claim = (value: unknown, qualifiers: Record<string, unknown[]> = {}, rank = "normal") => ({
  mainsnak: { datavalue: { value } }, rank,
  qualifiers: Object.fromEntries(Object.entries(qualifiers).map(([p, values]) => [p, values.map((v) => ({ datavalue: { value: v } }))])),
});
const item = (id: string) => ({ "entity-type": "item", id });

export const SOFI_SEARCH = { search: [
  { id: "Q999001", label: "Sofi", description: "given name" },
  { id: "Q17020720", label: "SoFi", description: "American financial services company" },
] };
export const SOFI_ENTITIES = { entities: {
  Q999001: { id: "Q999001", labels: { en: { value: "Sofi" } }, claims: {}, sitelinks: {} },
  Q17020720: { id: "Q17020720", labels: { en: { value: "SoFi" } }, sitelinks: { enwiki: { title: "SoFi" } }, claims: {
    P154: [claim("SoFi logo.svg")],
    P856: [claim("http://sofi.com/")],
    P414: [claim(item("Q13677"), { P249: ["SOFI"] })],
  } },
} };
export const SOFI_WIKITEXT = { query: { pages: [{ title: "SoFi", revisions: [{ slots: { main: { content: `{{Short description|American financial services company}}
{{Infobox company
| name = SoFi Technologies, Inc.
| logo = SoFi_logo.svg
| traded_as = {{Ubl|{{NASDAQ|SOFI}}|[[Russell 1000]] component}}
| founders = {{collapsible list|title=List of founders|[[Mike Cagney]]|Dan Macklin|James Finnigan|Ian Brady}}
| key_people = {{ubl|[[Anthony Noto]] ([[Chief executive officer|CEO]])|Chris Lapointe ([[Chief financial officer|CFO]])<ref>{{cite web|url=https://example.com}}</ref>}}
| website = {{URL|https://sofi.com}}
}}
'''SoFi''' is a company.` } } }] }] } };
export const SOFI_IMAGES = { query: { pages: [
  { title: "Anthony Noto", thumbnail: { source: "https://thumb.wikimedia.org/wikipedia/commons/thumb/7/7f/Anthony-Noto-Headshot.jpg/250px-Anthony-Noto-Headshot.jpg?utm_source=en.wikipedia.org&utm_campaign=api" } },
  { title: "Mike Cagney", thumbnail: { source: "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/5e/Mike_Cagney.jpg/250px-Mike_Cagney.jpg" } },
] } };

/** A fetch stub that answers by API, recording every URL it was asked for. */
export function wikiFetch(answers: { search?: unknown; entities?: unknown; wikitext?: unknown; images?: unknown; people?: unknown }) {
  const urls: string[] = [];
  const fetchJson = async (url: string) => {
    urls.push(url);
    const u = new URL(url);
    const action = u.searchParams.get("action");
    const prop = u.searchParams.get("prop") ?? "";
    if (u.hostname === "www.wikidata.org" && action === "wbsearchentities") return answers.search ?? { search: [] };
    if (u.hostname === "www.wikidata.org" && action === "wbgetentities") {
      const ids = (u.searchParams.get("ids") ?? "").split("|");
      if (answers.people && ids.every((id) => (answers.people as { entities: Record<string, unknown> }).entities[id])) return answers.people;
      return answers.entities ?? { entities: {} };
    }
    if (u.hostname === "en.wikipedia.org" && prop.includes("revisions")) return answers.wikitext ?? { query: { pages: [] } };
    if (u.hostname === "en.wikipedia.org" && prop.includes("pageimages")) return answers.images ?? { query: { pages: [] } };
    throw new Error(`unexpected url ${url}`);
  };
  return { fetchJson, urls };
}

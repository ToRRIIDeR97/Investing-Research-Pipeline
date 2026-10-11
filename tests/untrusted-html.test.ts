import assert from "node:assert/strict";
import test from "node:test";
import { discoverRoleSources, extractPublicLinks, parseBingHtml } from "../src/lib/research/sources/role-discovery";
import { filingPlainText } from "../src/lib/research/history/headcount";
import { nestingDepth } from "../src/lib/html-scan";

const MB = 1_000_000;
const fill = (unit: string, size = MB) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
const relevant = `<html><head><title>Acme founder history</title></head><body><p>${"documented founder history of Acme ".repeat(90)}</p>`;

// Each body defeated one of the old backtracking patterns (cubic links, quadratic script/tag/title
// stripping) or the DOM parser behind htmlToStructuredText (nesting).
const hostilePages: Record<string, string> = {
  "unterminated anchors": fill("<a href='x' "),
  "unclosed script": fill("<script"),
  "unclosed tags": fill("<a"),
  "unclosed title": `<title>${fill("x ")}`,
  "date meta without end": fill('<meta name="date" '),
  "unclosed article": fill("<article "),
  "relevant page nested 200,000 deep": (relevant + fill("<div>")).slice(0, MB),
  "relevant page of unmatched end tags": (relevant + fill("<b>", MB / 2) + fill("</i>", MB / 2)).slice(0, MB),
};

async function withDiscoveryEnv<T>(run: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  process.env.RESEARCH_WEB_SEARCH_ENDPOINT = "https://search.example/api";
  delete process.env.RESEARCH_WEB_SEARCH_API_KEY;
  delete process.env.RESEARCH_ACCEPTANCE_PROVIDER;
  delete process.env.RESEARCH_TEST_MODE;
  delete process.env.RESEARCH_WEB_DISCOVERY_ENABLED;
  try {
    return await run();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

test("a 1 MB adversarial page is processed in under 1 s", async () => {
  for (const [name, body] of Object.entries(hostilePages)) {
    const fetchMock = (async (input: string | URL | Request) => String(input).startsWith("https://search.example/api")
      ? new Response(JSON.stringify({ results: [{ url: "https://acme.example/history", title: "Acme history" }] }),
        { headers: { "content-type": "application/json" } })
      : new Response(body, { headers: { "content-type": "text/html" } })) as typeof fetch;
    const started = performance.now();
    const sources = await withDiscoveryEnv(() => discoverRoleSources({
      assetName: "Acme Company", symbol: "ACME", seedUrls: ["https://acme.example/investors"],
    }, ["founder_and_company_history", "company_investor_relations"], fetchMock));
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1_000, `${name}: ${Math.round(elapsed)} ms`);
    if (name.startsWith("relevant")) {
      // Too deep for the structured-text parser, so it is stored as flat text instead.
      const history = sources.find((source) => source.metadata.source_role === "founder_and_company_history");
      assert.ok(history, name);
      assert.match(history.content, /^Acme founder history documented founder history of Acme/);
    }
  }

  for (const unit of ["<a href='x' ", "<script", "<a", "<title>", '<li class="b_algo"><h2><a href="https://e.example/x">']) {
    const html = fill(unit);
    const started = performance.now();
    extractPublicLinks("https://acme.example/", html);
    parseBingHtml(html, "q");
    nestingDepth(html);
    assert.ok(performance.now() - started < 1_000, unit);
  }
});

test("filing text extraction is linear on unclosed script, style, ix:header and tags", () => {
  for (const unit of ["<script", "<style x", "<ix:header", "<p", "<"]) {
    const started = performance.now();
    filingPlainText(fill(unit));
    assert.ok(performance.now() - started < 1_000, unit);
  }
  assert.equal(filingPlainText("<p>We had</p><script>var x = '<p>';</script><ix:header>hidden</ix:header><p>1,200 employees</p>"),
    "We had\n1,200 employees");
});

test("link and result extraction keep browser semantics without a DOM parser", () => {
  const links = extractPublicLinks("https://acme.example/investors/", [
    '<a href="/report?a=1&amp;b=2">Annual <b>report</b></a>',
    "<a href=/history>History",
    '<a href="/next">Next</a>',
    '<a href="/page#section">Fragment</a>',
    '<script>document.write("<a href=\'/js\'>js</a>")</script>',
  ].join(""));
  assert.deepEqual(links.slice(0, 3), [
    { url: "https://acme.example/report?a=1&b=2", text: "Annual report" },
    { url: "https://acme.example/history", text: "History" },
    { url: "https://acme.example/next", text: "Next" },
  ]);
  assert.equal(links.some((link) => link.url.includes("page")), false);
  assert.deepEqual(parseBingHtml([
    '<li class="b_algo"><h2><a href="https://one.example/a">One</a></h2><a href="https://skip.example/">x</a></li>',
    '<li class="other"><h2><a href="https://two.example/b">Two</a></h2></li>',
  ].join(""), "q").map((candidate) => candidate.url), ["https://one.example/a"]);
  assert.equal(nestingDepth("<div><span><p>a<p>b<br><img/></span></div><div></div>"), 2);
  assert.equal(nestingDepth("<div><span></div></div><i></i>"), 2);
});

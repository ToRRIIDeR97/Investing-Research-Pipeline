import test from "node:test";
import assert from "node:assert/strict";
import { earningsText, loadMemory, prospectusHtml } from "./fixtures";

type Passage = { index: number; text: string; sectionPath: string[]; page: number | null; blockTypes: string[]; charStart: number; charEnd: number };

test("AC-1: prospectus headings form section paths and the founding story lands under History of MercadoLibre", () => {
  const { documentPassages } = loadMemory();
  const passages: Passage[] = documentPassages(prospectusHtml("p1"), "text/html");
  const history = passages.find(p => p.text.includes("co-founder"));
  assert.ok(history, "a passage holds the founding story");
  assert.deepEqual(history!.sectionPath, ["BUSINESS", "History of MercadoLibre"]);
  assert.match(history!.text, /Marcos Galperín, our co-founder/);
  assert.match(history!.text, /master’s degree/);
  assert.deepEqual(passages.find(p => p.text.includes("growth of e-commerce"))!.sectionPath, ["RISK FACTORS"]);
});

test("AC-1: scripts, styles, the head and hidden inline-XBRL content are dropped; table cells are never headings", () => {
  const { documentPassages } = loadMemory();
  const passages: Passage[] = documentPassages(prospectusHtml("p2"), "text/html");
  const all = passages.map(p => p.text).join("\n");
  assert.doesNotMatch(all, /hidden p2|font-size|d424b1\.htm/);
  assert.ok(passages.every(p => !p.sectionPath.includes("Prospectus summary")), "a bold cell inside the contents table is not a heading");
  const table = passages.find(p => p.blockTypes.includes("table") && p.text.includes("Net revenues"));
  assert.ok(table);
  assert.match(table!.text, /Year \| Net revenues\n2005 \| \$31\.4\n2006 \| \$51\.7/);
});

test("AC-1: entities decode, including Windows-1252 numeric references and non-breaking spaces", () => {
  const { decodeHtmlEntities } = loadMemory();
  assert.equal(decodeHtmlEntities("Galper&iacute;n&#146;s&nbsp;plan &amp; &#8212; &#x2019;"), "Galperín’s plan & — ’");
});

test("AC-2: plain text pages split on form feeds and short standalone lines become headings", () => {
  const { documentPassages } = loadMemory();
  const passages: Passage[] = documentPassages(`${earningsText("t1")}\f\nOutlook\n\nWe expect margins to expand next year.`, "text/plain");
  const credit = passages.find(p => p.text.includes("Non-performing loans"));
  assert.deepEqual(credit!.sectionPath, ["Credit Quality"]);
  assert.equal(credit!.page, 1);
  const outlook = passages.find(p => p.text.includes("margins to expand"));
  assert.deepEqual(outlook!.sectionPath, ["Outlook"]);
  assert.equal(outlook!.page, 2);
  assert.deepEqual(documentPassages("  \n\t ", "text/plain"), []);
});

test("AC-3: passages stay inside one section, respect maxChars and start with their heading", () => {
  const { documentPassages } = loadMemory();
  const passages: Passage[] = documentPassages(prospectusHtml("p3"), "text/html", { maxChars: 600 });
  assert.ok(passages.length > 3);
  assert.ok(passages.every(p => p.text.length <= 600), "every passage fits maxChars");
  const history = passages.filter(p => p.sectionPath.at(-1) === "History of MercadoLibre");
  assert.ok(history.length >= 1);
  assert.ok(history[0].text.startsWith("History of MercadoLibre"));
  assert.ok(passages.every(p => !(p.text.includes("co-founder") && p.text.includes("growth of e-commerce"))), "no passage spans two sections");
  for (let i = 1; i < passages.length; i++) {
    assert.equal(passages[i].index, passages[i - 1].index + 1);
    assert.ok(passages[i].charStart >= passages[i - 1].charEnd, "offsets follow reading order");
  }
});

test("AC-1: streamed page bodies inside hidden-attribute containers are kept (React streaming rendering)", () => {
  const { documentPassages, htmlToStructuredText } = loadMemory();
  const page = `<html><body><a href="#main">Skip to main content</a><main id="main-content"><template id="B:0"></template></main>
    <div hidden id="S:0"><h1>Mike Cagney</h1><h2>Background</h2><p>Mike Cagney co-founded SoFi in 2011 while at Stanford.</p></div>
    <script>document.getElementById("B:0").replaceWith(document.getElementById("S:0"))</script></body></html>`;
  const story = (documentPassages(page, "text/html") as Passage[]).find(p => p.text.includes("co-founded SoFi"));
  assert.deepEqual(story?.sectionPath, ["Mike Cagney", "Background"]);
  const reparsed = (documentPassages(htmlToStructuredText(page), "text/plain") as Passage[]).find(p => p.text.includes("co-founded SoFi"));
  assert.deepEqual(reparsed?.sectionPath, ["Mike Cagney", "Background"], "stored web-page text keeps the sections");
});

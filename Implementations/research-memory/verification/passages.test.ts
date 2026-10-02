import test from "node:test";
import assert from "node:assert/strict";
import { memory } from "./fixtures";

type Passage = { index: number; text: string; sectionPath: string[]; page: number | null; blockTypes: string[]; charStart: number; charEnd: number };
const find = (passages: Passage[], fragment: string) => passages.find(p => p.text.includes(fragment));

test("AC-1: h1-h6 levels nest and a heading replaces headings at its level or deeper", () => {
  const html = `<h1>Annual Report</h1><h2>Segments</h2><h3>Fintech</h3><p>Fintech revenue grew.</p>
    <h2>Risks</h2><p>Currency risk is material.</p><h4>Argentina</h4><p>Peso devaluation hurt margins.</p>`;
  const passages: Passage[] = memory().documentPassages(html, "text/html");
  assert.deepEqual(find(passages, "Fintech revenue")!.sectionPath, ["Annual Report", "Segments", "Fintech"]);
  assert.deepEqual(find(passages, "Currency risk")!.sectionPath, ["Annual Report", "Risks"]);
  assert.deepEqual(find(passages, "Peso devaluation")!.sectionPath, ["Annual Report", "Risks", "Argentina"]);
});

test("AC-1: bold headings follow the length, period and table-cell rules", () => {
  const long = "A".repeat(40) + " bold line that keeps going well past the one hundred and twenty character limit for headings in filings";
  const html = `<div><strong>OUR COMPANY</strong></div><p>Intro paragraph.</p>
    <div><span style="font-weight: 700">Founding Team</span></div><p>Two engineers started it.</p>
    <p><b>This bold sentence ends with a period.</b></p><p>After the bold sentence.</p>
    <p><b>${long}</b></p><p>After the long bold line.</p>
    <table><tr><th><b>Quarter</b></th><th>Revenue</th></tr><tr><td>Q1</td><td>10</td></tr></table><p>After the table.</p>`;
  const passages: Passage[] = memory().documentPassages(html, "text/html");
  assert.deepEqual(find(passages, "Intro paragraph")!.sectionPath, ["OUR COMPANY"]);
  assert.deepEqual(find(passages, "Two engineers")!.sectionPath, ["OUR COMPANY", "Founding Team"]);
  assert.deepEqual(find(passages, "After the bold sentence")!.sectionPath, ["OUR COMPANY", "Founding Team"]);
  assert.deepEqual(find(passages, "After the long bold line")!.sectionPath, ["OUR COMPANY", "Founding Team"]);
  assert.deepEqual(find(passages, "After the table")!.sectionPath, ["OUR COMPANY", "Founding Team"]);
});

test("AC-1: hidden spans and bare ix:header blocks are dropped; escaped markup stays literal text", () => {
  const html = `<ix:header><ix:references>hidden reference</ix:references></ix:header>
    <p>Visible <span style="display: none">secret note</span>text &lt;b&gt;not bold&lt;/b&gt; &mdash; caf&eacute; &#150; &#x27;quoted&#x27;</p>`;
  const text = (memory().documentPassages(html, "text/html") as Passage[]).map(p => p.text).join(" ");
  assert.doesNotMatch(text, /hidden reference|secret note/);
  assert.match(text, /Visible text <b>not bold<\/b> — café – 'quoted'/);
});

test("AC-2: Markdown and upper-case headings count, colon lines and long lines do not, and no form feed means no page", () => {
  const long = "This line is a sentence fragment that is clearly far too long to be treated as any kind of heading";
  const text = ["## Liquidity", "", "Cash covers two years of spending.", "", "RISK FACTORS", "", "Rates may rise.", "",
    "Key points:", "", "Margins are stable.", "", long, "", "Final paragraph text."].join("\n");
  const passages: Passage[] = memory().documentPassages(text, "text/plain");
  assert.deepEqual(find(passages, "Cash covers")!.sectionPath, ["Liquidity"]);
  assert.deepEqual(find(passages, "Rates may rise")!.sectionPath, ["RISK FACTORS"]);
  assert.deepEqual(find(passages, "Margins are stable")!.sectionPath, ["RISK FACTORS"]);
  assert.deepEqual(find(passages, "Final paragraph")!.sectionPath, ["RISK FACTORS"]);
  assert.ok(passages.every(p => p.page === null));
});

test("AC-2: JSON forms passages without headings and empty HTML forms none", () => {
  const passages: Passage[] = memory().documentPassages(JSON.stringify({ facts: { revenue: 1234, currency: "USD" } }), "application/json");
  assert.ok(passages.length >= 1);
  assert.ok(passages.every(p => p.sectionPath.length === 0));
  assert.match(passages.map(p => p.text).join(" "), /1234/);
  assert.deepEqual(memory().documentPassages("<html><body>  </body></html>", "text/html"), []);
});

test("AC-3: long paragraphs split at sentence boundaries and long tables at row boundaries", () => {
  const sentences = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} describes the lending book in some detail.`).join(" ");
  const rows = Array.from({ length: 200 }, (_, i) => `<tr><td>Row ${i}</td><td>${i * 3}</td></tr>`).join("");
  const passages: Passage[] = memory().documentPassages(`<h2>Credit</h2><p>${sentences}</p><h2>Data</h2><table>${rows}</table>`, "text/html");
  const credit = passages.filter(p => p.sectionPath.at(-1) === "Credit");
  assert.ok(credit.length >= 2);
  assert.ok(credit.every(p => p.text.length <= 2400 && /\.$/.test(p.text.trim())), "each piece ends at a sentence boundary");
  const data = passages.filter(p => p.sectionPath.at(-1) === "Data");
  assert.ok(data.length >= 2);
  for (const piece of data) {
    assert.ok(piece.text.length <= 2400);
    for (const line of piece.text.split("\n").filter(l => l.startsWith("Row "))) assert.match(line, /^Row \d+ \| \d+$/, "no row is cut");
  }
});

test("AC-3: a section that continues across a page break becomes separate passages per page", () => {
  const text = "Operations\n\nWarehouses expanded in Brazil.\fMore warehouses opened in Mexico.";
  const passages: Passage[] = memory().documentPassages(text, "text/plain");
  const brazil = find(passages, "Brazil")!, mexico = find(passages, "Mexico")!;
  assert.notEqual(brazil, mexico);
  assert.equal(brazil.page, 1);
  assert.equal(mexico.page, 2);
  assert.deepEqual(mexico.sectionPath, ["Operations"]);
});

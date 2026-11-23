// P1: AC-5 shared primitives.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

const load = () => import("../../../src/components/ui/primitives");

test("AC-5: Card renders a section with an h2 title", async () => {
  const { Card } = await load();
  const html = renderToStaticMarkup(<Card title="Price">body</Card>);
  assert.match(html, /^<section/);
  assert.match(html, /<h2[^>]*>Price<\/h2>/);
  assert.match(html, /body/);
});

test("AC-5: Tag carries its tone and a dot", async () => {
  const { Tag } = await load();
  const html = renderToStaticMarkup(<Tag tone="waiting">Needs your decision</Tag>);
  assert.match(html, /^<span[^>]*data-tone="waiting"/);
  assert.match(html, /Needs your decision/);
  assert.ok((html.match(/<(span|i)\b/g) ?? []).length >= 2, "a dot element inside the tag");
});

test("AC-5: Segmented is a labelled group with one pressed button", async () => {
  const { Segmented } = await load();
  const html = renderToStaticMarkup(<Segmented label="Range" options={["1M", "6M", "1Y"]} value="6M" onChange={() => {}} />);
  assert.match(html, /role="group"/);
  assert.match(html, /aria-label="Range"/);
  assert.equal((html.match(/<button/g) ?? []).length, 3);
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
  assert.match(html, /aria-pressed="true"[^>]*>6M</);
});

test("AC-5: BigNumber marks its value", async () => {
  const { BigNumber } = await load();
  const html = renderToStaticMarkup(<BigNumber value="$14.28" label="Price" />);
  assert.match(html, /data-big[^>]*>\$14\.28</);
});

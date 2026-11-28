// V1 (P1): boundaries the acceptance set doesn't touch.
import "./v-support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { read } from "./v-support";

test("V1/AC-1: chart series start with navy and stay in the navy and grey family", async () => {
  const { C, SERIES } = await import("../../../src/components/ui/palette");
  assert.equal(SERIES[0], C.navy);
  for (const c of SERIES) assert.ok(![C.positive, C.critical, C.caution].includes(c as never), `status colour ${c} used as a series colour`);
});

test("V1/AC-2: reduced motion still switches animation off", () => {
  assert.match(read("src/app/globals.css"), /prefers-reduced-motion:\s*reduce/);
});

test("V1/AC-2: no stylesheet anywhere still imports the old faces", () => {
  const css = read("src/app/globals.css");
  assert.doesNotMatch(css, /family=JetBrains|family=DM\+Serif/);
});

test("V1/AC-5: every Tag tone renders, and an unmatched Segmented value presses nothing", async () => {
  const { Tag, Segmented } = await import("../../../src/components/ui/primitives");
  for (const tone of ["neutral", "waiting", "good", "bad"] as const) assert.match(renderToStaticMarkup(<Tag tone={tone}>x</Tag>), new RegExp(`data-tone="${tone}"`));
  const html = renderToStaticMarkup(<Segmented label="Range" options={["1M", "1Y"]} value="5Y" onChange={() => {}} />);
  assert.doesNotMatch(html, /aria-pressed="true"/);
});

test("V1/AC-5: Card without a title has no heading", async () => {
  const { Card } = await import("../../../src/components/ui/primitives");
  assert.doesNotMatch(renderToStaticMarkup(<Card>only body</Card>), /<h2/);
});

test("V1/AC-4: the logo keeps the login page and shell working (mark still exported)", async () => {
  const mod = await import("../../../src/components/brand/logo");
  assert.equal(typeof mod.PragmaMark, "function");
  assert.match(renderToStaticMarkup(<mod.PragmaMark size={30} />), /<svg[^>]*width="30"/);
});

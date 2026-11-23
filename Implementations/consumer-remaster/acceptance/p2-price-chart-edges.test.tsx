// P2 (added by the implementor): PriceChart edge cases from review — a flat series and the scrub announcement.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

const kit = () => import("../../../src/components/interactive");

test("PriceChart: a flat series draws one axis tick, not three identical ones", async () => {
  const { PriceChart } = await kit();
  const html = renderToStaticMarkup(<PriceChart points={[{ day: "2026-01-02", close: 5 }, { day: "2026-01-05", close: 5 }]} currency="USD" />);
  assert.equal((html.match(/>\$5\.00<\/text>/g) ?? []).length, 1);
});

test("PriceChart: change arrows are hidden from screen readers and a polite live region exists", async () => {
  const { PriceChart } = await kit();
  const html = renderToStaticMarkup(<PriceChart points={[{ day: "2026-05-20", close: 12.1 }, { day: "2026-08-18", close: 15.01 }]} currency="USD" />);
  assert.match(html, /<span aria-hidden="true">▲ <\/span>/);
  assert.match(html, /aria-live="polite"/);
});

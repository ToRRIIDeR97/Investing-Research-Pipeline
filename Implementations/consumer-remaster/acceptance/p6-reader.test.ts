// P6: AC-17 the reader pages lose their subtitles; AC-1 to AC-3 already sweep the whole tree.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { read } from "./support";

test("AC-17: tile-head subtitles are gone from the report reader", () => {
  const view = read("src/app/assets/[id]/view/page.tsx");
  for (const s of ["Ranked by likelihood", "Value per share at each year end", "Current level between its bear and bull thresholds"]) assert.ok(!view.includes(s), s);
});

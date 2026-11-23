// P5: AC-16 Home, Research list, Themes and Start research are built from the primitives.
import "./support";
import { test } from "node:test";
import assert from "node:assert/strict";
import { read } from "./support";

const PAGES = ["src/app/page.tsx", "src/app/assets/page.tsx", "src/app/themes/page.tsx", "src/app/research/new/page.tsx"];

test("AC-16: the four pages import the primitives", () => {
  for (const p of PAGES) assert.match(read(p), /from "@\/components\/ui\/primitives"/, p);
});

test("AC-16: Home and the Research list count current reviews only", () => {
  for (const p of ["src/app/page.tsx", "src/app/assets/page.tsx"]) assert.match(read(p), /reviewCount\(|currentReviews\(/, p);
});

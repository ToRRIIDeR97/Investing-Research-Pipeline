// AC-3: the API says when pending lookups are slow because they run unidentified, and the UI shows a quiet note.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lookupThrottled } from "../../../src/lib/company-profiles/cache";

const src = (path: string) => readFileSync(resolve(__dirname, "../../..", path), "utf8");

test("AC-3: throttled only while keys are pending and lookups are unidentified", () => {
  assert.equal(lookupThrottled(["ticker:A"], false), true);
  assert.equal(lookupThrottled(["ticker:A"], true), false);
  assert.equal(lookupThrottled([], false), false);
  assert.equal(lookupThrottled([], true), false);
});

test("AC-3: the store returns throttled, the hook keeps it, the UI shows the note", () => {
  const store = src("src/lib/company-profiles/store.ts");
  assert.match(store, /throttled:\s*lookupThrottled\(pending,\s*wikimediaIdentified\(\)\)/);
  const hook = src("src/components/company/use-company-profiles.ts");
  assert.match(hook, /throttled: boolean/);
  assert.match(hook, /export const SLOW_LOOKUP_NOTE = /);
  const ui = src("src/components/company/company.tsx");
  assert.match(ui, /SLOW_LOOKUP_NOTE/);
  assert.match(ui, /title=\{loading && throttled \? SLOW_LOOKUP_NOTE : undefined\}/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { genesisMissingRoles, MISSING_HISTORY_RULE, GENESIS_PROMPT_RULES } from "../src/lib/research/handlers/company-genesis";

test("a run without a founder or company-history document is a packet note, not a stop", () => {
  assert.deepEqual(genesisMissingRoles(["regulatory_filing", "earnings_release"]), ["founder_and_company_history"]);
  assert.deepEqual(genesisMissingRoles(["founder_and_company_history", "regulatory_filing"]), []);
  // The rule names the packet key, says to use the filings at low confidence and to state the limit, and is added only
  // when a role is missing, so runs that have the source send the prompt they always sent.
  assert.match(MISSING_HISTORY_RULE, /missing_source_roles/);
  assert.match(MISSING_HISTORY_RULE, /low confidence/);
  assert.match(MISSING_HISTORY_RULE, /founder_background/);
  assert.ok(!GENESIS_PROMPT_RULES.includes(MISSING_HISTORY_RULE));
});

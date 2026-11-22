// AC-2: lookup identity is explicit, and the operator is told once, on the server, when lookups run unidentified.
// The existing guarantees (sanitised contact in the User-Agent, Retry-After blocking) still hold.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { createUnidentifiedNotice, RateLimitedError, wikimediaFetchJson, wikimediaIdentified, wikimediaSpacingMs, wikimediaUserAgent } from "../../../src/lib/company-profiles/resolve";

const withContact = (value: string | undefined, fn: () => void) => {
  const before = process.env.WIKIMEDIA_CONTACT;
  if (value === undefined) delete process.env.WIKIMEDIA_CONTACT; else process.env.WIKIMEDIA_CONTACT = value;
  try { fn(); } finally { if (before === undefined) delete process.env.WIKIMEDIA_CONTACT; else process.env.WIKIMEDIA_CONTACT = before; }
};

test("AC-2: identified only with a usable WIKIMEDIA_CONTACT; spacing follows", () => {
  withContact(undefined, () => { assert.equal(wikimediaIdentified(), false); assert.equal(wikimediaSpacingMs(), 6_500); });
  withContact("   ", () => assert.equal(wikimediaIdentified(), false));
  withContact("<>\"' ", () => assert.equal(wikimediaIdentified(), false));
  withContact("https://example.org/ops", () => { assert.equal(wikimediaIdentified(), true); assert.equal(wikimediaSpacingMs(), 400); });
});

test("AC-2: the unidentified notice is one line, logged once, naming the fix", () => {
  const lines: string[] = [];
  const notice = createUnidentifiedNotice((line) => lines.push(line));
  withContact(undefined, () => { notice(); notice(); notice(); });
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes("\n"));
  for (const part of ["WIKIMEDIA_CONTACT", "10", "200", "docs/operations.md"]) assert.ok(lines[0].includes(part), `missing ${part}: ${lines[0]}`);
  assert.match(lines[0], /^\[company-profiles\] Wikimedia lookups are unidentified/);
});

test("AC-2: no notice while identified", () => {
  const lines: string[] = [];
  const notice = createUnidentifiedNotice((line) => lines.push(line));
  withContact("https://example.org/ops", () => { notice(); notice(); });
  assert.deepEqual(lines, []);
});

test("AC-2: the live fetcher logs the notice before its first unidentified request, then keeps its guarantees", async () => {
  const previous = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  const warn = mock.method(console, "warn", () => {});
  const before = process.env.WIKIMEDIA_CONTACT;
  try {
    delete process.env.WIKIMEDIA_CONTACT;
    const agents: string[] = [];
    const wikidata = agent.get("https://www.wikidata.org");
    wikidata.intercept({ path: /\/w\/api\.php.*/, method: "GET" }).reply((opts) => {
      agents.push(String((opts.headers as Record<string, string>)["user-agent"]));
      return { statusCode: 200, data: { ok: 1 } };
    }).times(2);
    assert.deepEqual(await wikimediaFetchJson("https://www.wikidata.org/w/api.php?a=1"), { ok: 1 });
    const notices = warn.mock.calls.filter((c) => String(c.arguments[0]).startsWith("[company-profiles]"));
    assert.equal(notices.length, 1);
    assert.equal(agents[0], "PragmaResearch/1.0 (self-hosted research tool) undici");

    process.env.WIKIMEDIA_CONTACT = "https://example.org/ops <x>";
    assert.deepEqual(await wikimediaFetchJson("https://www.wikidata.org/w/api.php?a=2"), { ok: 1 });
    assert.equal(agents[1], "PragmaResearch/1.0 (https://example.org/opsx) undici");
    assert.equal(warn.mock.calls.filter((c) => String(c.arguments[0]).startsWith("[company-profiles]")).length, 1);

    wikidata.intercept({ path: /\/w\/api\.php.*/, method: "GET" }).reply(429, "slow down", { headers: { "retry-after": "120" } });
    const started = Date.now();
    await assert.rejects(wikimediaFetchJson("https://www.wikidata.org/w/api.php?a=3"), (error: unknown) =>
      error instanceof RateLimitedError && error.until >= started + 119_000);
    // Blocked: refused without a request (no interceptor is left, and net connect is off).
    await assert.rejects(wikimediaFetchJson("https://www.wikidata.org/w/api.php?a=4"), RateLimitedError);
  } finally {
    if (before === undefined) delete process.env.WIKIMEDIA_CONTACT; else process.env.WIKIMEDIA_CONTACT = before;
    warn.mock.restore();
    setGlobalDispatcher(previous);
    await agent.close();
  }
});

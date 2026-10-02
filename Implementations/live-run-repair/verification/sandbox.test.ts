import test from "node:test";
import assert from "node:assert/strict";
import { runRepairModule } from "../../../src/lib/research/repair/statement-repair";

const fails = async (source: string, pattern?: RegExp, options?: { timeoutMs?: number }) => {
  const result = await runRepairModule(source, [{ a: 1 }], options);
  assert.equal(result.ok, false, `expected failure for: ${source.slice(0, 60)}`);
  if (pattern && !result.ok) assert.match(result.error, pattern);
};

test("AC-9: input arrives as plain data and output must be JSON data", async () => {
  assert.deepEqual(await runRepairModule("function locateStatements(input) { return input.map(x => ({ n: x.a + 1 })); }", [{ a: 1 }]),
    { ok: true, output: [{ n: 2 }] });
  await fails("function locateStatements() { return () => 1; }");
  await fails("function notTheEntryPoint() { return []; }", /locateStatements/);
  await fails("function locateStatements( {", /SyntaxError|Unexpected/);
});

test("AC-9: host capabilities are unreachable from the module", async () => {
  const probe = await runRepairModule(`function locateStatements() {
    const found = [];
    for (const name of ["process", "require", "fetch", "Buffer", "setTimeout", "module"]) if (typeof globalThis[name] !== "undefined") found.push(name);
    return found;
  }`, []);
  assert.deepEqual(probe, { ok: true, output: [] });
  await fails("function locateStatements() { return import('node:fs'); }");
  await fails("async function locateStatements() { const fs = await import('node:fs'); return fs.readFileSync('/etc/hosts', 'utf8'); }");
});

test("AC-9: runaway modules fail within their limits without affecting the caller", async () => {
  const started = Date.now();
  await fails("function locateStatements() { for (;;) {} }", undefined, { timeoutMs: 300 });
  assert.ok(Date.now() - started < 10_000);
  await fails("function locateStatements() { return 'x'.repeat(5 * 1024 * 1024); }", /output/i);
  await fails("function locateStatements() { const a = []; for (;;) a.push(new Array(1e6).fill(1)); }", undefined, { timeoutMs: 5000 });
});

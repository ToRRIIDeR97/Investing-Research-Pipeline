import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadResearchEnvFiles } from "../src/lib/config/research-env";

test("model routing comes from env files rather than command-scoped overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "research-env-"));
  const previous = process.env.RESEARCH_VALUATION_ANALYST_MODEL;
  try {
    await writeFile(join(directory, ".env.local"), "RESEARCH_VALUATION_ANALYST_MODEL=file-model\n");
    process.env.RESEARCH_VALUATION_ANALYST_MODEL = "command-model";
    loadResearchEnvFiles(directory);
    assert.equal(process.env.RESEARCH_VALUATION_ANALYST_MODEL, "file-model");
  } finally {
    if (previous === undefined) delete process.env.RESEARCH_VALUATION_ANALYST_MODEL;
    else process.env.RESEARCH_VALUATION_ANALYST_MODEL = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

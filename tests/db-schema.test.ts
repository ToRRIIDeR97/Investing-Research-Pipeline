import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { schema } from "../src/db";

test("the app's Drizzle client registers every schema module (#17)", async () => {
  const dir = join(process.cwd(), "src", "db", "schema");
  const files = readdirSync(dir).filter(file => file.endsWith(".ts"));
  assert.ok(files.includes("source-intelligence.ts") && files.includes("market-data.ts"));
  for (const file of files) {
    const module = await import(pathToFileURL(join(dir, file)).href);
    for (const [name, value] of Object.entries(module)) {
      assert.equal((schema as Record<string, unknown>)[name], value, `${file} export ${name} is missing from the db schema`);
    }
  }
});

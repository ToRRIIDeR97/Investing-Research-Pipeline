import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("docker compose publishes Postgres on loopback only, with an overridable password (S4)", () => {
  const compose = readFileSync("docker-compose.yml", "utf8");
  const ports = [...compose.matchAll(/^\s*-\s*"([^"]*:5432)"/gm)].map((match) => match[1]);
  assert.deepEqual(ports, ["127.0.0.1:5432:5432"]);
  assert.match(compose, /POSTGRES_PASSWORD:\s*\$\{POSTGRES_PASSWORD:-[^}]+\}/);
});

test("python/requirements.txt lists docling, which the upload parser imports (#21)", () => {
  assert.match(readFileSync("python/parsers/docling_parser.py", "utf8"), /from docling\.document_converter import/);
  const packages = readFileSync("python/requirements.txt", "utf8").split(/\r?\n/).map((line) => line.split(/[<>=#\s]/)[0]).filter(Boolean);
  for (const name of ["docling", "pandas", "numpy", "yfinance"]) assert.ok(packages.includes(name), name);
});

test(".env.example lists every web-discovery setting the code reads (#26)", () => {
  const source = readFileSync("src/lib/research/sources/role-discovery.ts", "utf8");
  const read = new Set([...source.matchAll(/process\.env\.(RESEARCH_(?:WEB|BING)_[A-Z_]+)/g)].map((match) => match[1]));
  assert.ok(read.has("RESEARCH_WEB_SEARCH_API_KEY"));
  const example = readFileSync(".env.example", "utf8");
  for (const name of read) assert.match(example, new RegExp(`^${name}=`, "m"), name);
});

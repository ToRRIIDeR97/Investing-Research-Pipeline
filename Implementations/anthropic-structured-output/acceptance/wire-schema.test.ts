// AC-1 and AC-2 on the pure function anthropicWireSchema(schema).
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod/v4";
import { getAgentConfig } from "../../../src/lib/agent-harness/registry";
import { outputContract } from "../../../src/lib/research/reporting/contracts";
import { loadWireSchema } from "./fixtures";

/** The same zod definition as BRIEF_CONTRACT in src/lib/research/team.ts (not exported there). */
const BRIEF = outputContract({
  approach: z.string().min(1),
  checks: z.array(z.string().min(1)).min(1),
  information_needed: z.array(z.string().min(1)),
});

test("AC-1: the team brief contract becomes a closed schema without length limits or $schema", () => {
  const anthropicWireSchema = loadWireSchema();
  const before = JSON.stringify(BRIEF.schema);
  const result = anthropicWireSchema(BRIEF.schema!);
  assert.ok("schema" in result, `expected an expressible schema, got ${JSON.stringify(result)}`);
  assert.deepEqual(result.schema, {
    type: "object",
    properties: {
      approach: { type: "string" },
      checks: { minItems: 1, type: "array", items: { type: "string" } },
      information_needed: { type: "array", items: { type: "string" } },
    },
    required: ["approach", "checks", "information_needed"],
    additionalProperties: false,
  });
  assert.equal(JSON.stringify(BRIEF.schema), before, "the contract's own schema is not mutated");
});

test("AC-1: unsupported keywords are stripped, supported ones kept, every object closed", () => {
  const anthropicWireSchema = loadWireSchema();
  const input = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    description: "fixture",
    properties: {
      id: { type: "string", format: "uuid", pattern: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$" },
      as_of: { type: "string", format: "date" },
      slug: { type: "string", format: "slug", minLength: 3, maxLength: 40 },
      count: { type: "integer", minimum: -9007199254740991, maximum: 9007199254740991 },
      share: { type: "number", exclusiveMinimum: 0, maximum: 1, multipleOf: 0.01 },
      kind: { type: "string", enum: ["fact", "estimate"], default: "fact" },
      version: { type: "string", const: "1.0" },
      segment: { anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] },
      tags: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } },
      notes: { type: "array", minItems: 0, items: { type: "string" } },
      rows: {
        type: "array", minItems: 3, maxItems: 3,
        items: { type: "object", properties: { label: { type: "string", minLength: 1 }, value: { type: ["number", "null"] } }, required: ["label", "value"] },
      },
    },
    required: ["id", "as_of", "count", "share", "segment", "tags", "notes", "rows"],
  };
  const before = JSON.stringify(input);
  const result = anthropicWireSchema(input);
  assert.ok("schema" in result, `expected an expressible schema, got ${JSON.stringify(result)}`);
  assert.deepEqual(result.schema, {
    type: "object",
    description: "fixture",
    properties: {
      id: { type: "string", format: "uuid" },
      as_of: { type: "string", format: "date" },
      slug: { type: "string" },
      count: { type: "integer" },
      share: { type: "number" },
      kind: { type: "string", enum: ["fact", "estimate"], default: "fact" },
      version: { type: "string", const: "1.0" },
      segment: { anyOf: [{ type: "string" }, { type: "null" }] },
      tags: { type: "array", minItems: 1, items: { type: "string" } },
      notes: { type: "array", minItems: 0, items: { type: "string" } },
      rows: {
        type: "array",
        items: { type: "object", properties: { label: { type: "string" }, value: { type: ["number", "null"] } }, required: ["label", "value"], additionalProperties: false },
      },
    },
    required: ["id", "as_of", "count", "share", "segment", "tags", "notes", "rows"],
    additionalProperties: false,
  });
  assert.equal(JSON.stringify(input), before, "the input schema is not mutated");
});

test("AC-2: records and open objects are not expressible", () => {
  const anthropicWireSchema = loadWireSchema();
  const reviewerLike = z.toJSONSchema(z.object({
    review_summary: z.string().min(1),
    findings: z.array(z.record(z.string(), z.unknown())),
  }), { target: "draft-7", io: "input" }) as Record<string, unknown>;
  const record = anthropicWireSchema(reviewerLike);
  assert.ok("unsupported" in record && typeof record.unsupported === "string" && record.unsupported.length > 0,
    `a z.record schema is unsupported, got ${JSON.stringify(record).slice(0, 200)}`);

  const sourceReader = (getAgentConfig("source-reader").outputFormat as { schema: Record<string, unknown> }).schema;
  const open = anthropicWireSchema(sourceReader);
  assert.ok("unsupported" in open, "a registry schema with additionalProperties: true is unsupported");
});

test("AC-2: recursive schemas and schemas over the optional or union limits are not expressible", () => {
  const anthropicWireSchema = loadWireSchema();
  const recursive = {
    type: "object",
    properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "#" } } },
    required: ["name", "children"],
  };
  assert.ok("unsupported" in anthropicWireSchema(recursive), "a $ref back to the root is recursive");

  const optional = (n: number) => ({
    type: "object",
    properties: Object.fromEntries(Array.from({ length: n }, (_, i) => [`field_${i}`, { type: "string" }])),
    required: [],
  });
  assert.ok("unsupported" in anthropicWireSchema(optional(25)), "25 optional properties exceed the limit of 24");

  const unions = (n: number) => ({
    type: "object",
    properties: Object.fromEntries(Array.from({ length: n }, (_, i) => [`maybe_${i}`, { anyOf: [{ type: "string" }, { type: "null" }] }])),
    required: Array.from({ length: n }, (_, i) => `maybe_${i}`),
  });
  assert.ok("unsupported" in anthropicWireSchema(unions(17)), "17 union-typed properties exceed the limit of 16");
});

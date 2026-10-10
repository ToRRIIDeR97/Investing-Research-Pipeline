// Independent checks of anthropicWireSchema (AC-1, AC-2) on real contracts and boundary schemas.
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod/v4";
import { getAgentConfig } from "../../../src/lib/agent-harness/registry";
import {
  AI_REVIEWER_CONTRACT, DECISION_SYNTHESIS_CONTRACT, OPERATING_SCENARIOS_CONTRACT, VALUATION_CONTRACT,
} from "../../../src/lib/research/stage-contracts";
import { eachSchema, expressible, unsupported, wireModule } from "./fixtures";

const STRIPPED = ["$schema", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "maxItems", "pattern", "propertyNames"];
const FORMATS = ["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"];
const draft7 = (shape: z.ZodRawShape) => z.toJSONSchema(z.object(shape), { target: "draft-7", io: "input" }) as Record<string, unknown>;

function census(schema: Record<string, unknown>) {
  const out = { objects: 0, properties: 0, required: [] as string[], enums: [] as string[], anyOf: 0, uuid: 0 };
  eachSchema(schema, (node, path) => {
    if (node.type === "object") out.objects += 1;
    if (node.properties) out.properties += Object.keys(node.properties).length;
    if (Array.isArray(node.required)) out.required.push(`${path}:${node.required.join(",")}`);
    if (Array.isArray(node.enum)) out.enums.push(`${path}:${node.enum.join(",")}`);
    if (Array.isArray(node.anyOf)) out.anyOf += 1;
    if (node.format === "uuid") out.uuid += 1;
  });
  return out;
}

test("AC-1: DECISION_SYNTHESIS_CONTRACT keeps its structure and loses only unsupported constraints", () => {
  const { anthropicWireSchema } = wireModule();
  const source = DECISION_SYNTHESIS_CONTRACT.schema!;
  const before = JSON.stringify(source);
  const wire = expressible(anthropicWireSchema(source));
  assert.equal(JSON.stringify(source), before, "the contract schema is not mutated");
  eachSchema(wire, (node, path) => {
    for (const key of STRIPPED) assert.ok(!(key in node), `${path} still has ${key}`);
    if (typeof node.minItems === "number") assert.ok(node.minItems <= 1, `${path} keeps minItems ${node.minItems}`);
    if ("format" in node) assert.ok(FORMATS.includes(node.format), `${path} keeps unsupported format ${node.format}`);
    if (node.type === "object") assert.equal(node.additionalProperties, false, `${path} is closed`);
  });
  const a = census(source), b = census(wire);
  assert.deepEqual(b, a, "objects, properties, required lists, enums, unions and uuid formats are unchanged");
  assert.ok(a.uuid > 0 && a.anyOf > 0, "the fixture exercises uuid formats and nullable unions");
  assert.deepEqual(anthropicWireSchema(source), anthropicWireSchema(structuredClone(source)), "the result depends only on content");
});

test("AC-1: property names, enum values and defaults that look like keywords are data, not keywords", () => {
  const { anthropicWireSchema } = wireModule();
  const input = {
    type: "object",
    properties: {
      pattern: { type: "string", minLength: 2 },
      minimum: { type: "number" },
      format: { type: "string", enum: ["pattern", "maxLength"] },
      settings: {
        type: "object",
        properties: { maxItems: { type: "integer", minimum: 1 }, $schema: { type: "string" } },
        default: { maxItems: 3, pattern: "x" },
      },
    },
    required: ["pattern", "minimum", "format"],
  };
  assert.deepEqual(expressible(anthropicWireSchema(input)), {
    type: "object",
    properties: {
      pattern: { type: "string" },
      minimum: { type: "number" },
      format: { type: "string", enum: ["pattern", "maxLength"] },
      settings: {
        type: "object",
        properties: { maxItems: { type: "integer" }, $schema: { type: "string" } },
        default: { maxItems: 3, pattern: "x" },
        additionalProperties: false,
      },
    },
    required: ["pattern", "minimum", "format"],
    additionalProperties: false,
  });
});

test("AC-1: nested arrays of objects and nullable object unions are closed at every depth", () => {
  const { anthropicWireSchema } = wireModule();
  const input = draft7({
    grid: z.array(z.array(z.object({ cell: z.string().min(1), weight: z.number().min(0).max(1) })).min(2)).min(1),
    owner: z.object({ name: z.string(), since: z.iso.date() }).nullable(),
    contact: z.email().optional(),
    homepage: z.url().optional(),
    ref_id: z.cuid().optional(),
  });
  const wire = expressible(anthropicWireSchema(input));
  const grid = wire.properties.grid;
  assert.equal(grid.minItems, 1, "minItems 1 is kept");
  assert.equal("minItems" in grid.items, false, "minItems 2 is dropped");
  assert.deepEqual(grid.items.items, {
    type: "object", properties: { cell: { type: "string" }, weight: { type: "number" } }, required: ["cell", "weight"], additionalProperties: false,
  });
  const owner = wire.properties.owner.anyOf.find((member: any) => member.type === "object");
  assert.equal(owner.additionalProperties, false);
  assert.equal(owner.properties.since.format, "date");
  assert.deepEqual(wire.properties.owner.anyOf.find((member: any) => member.type === "null"), { type: "null" });
  assert.equal(wire.properties.contact.format, "email");
  assert.equal("format" in wire.properties.ref_id, false, "cuid is not an Anthropic format");
  assert.deepEqual(wire.required, input.required, "optional fields stay optional");
});

test("AC-1: a schema that is already closed stays expressible", () => {
  const { anthropicWireSchema } = wireModule();
  const input = { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] };
  assert.deepEqual(expressible(anthropicWireSchema(input)), input);
});

test("AC-2: VALUATION, OPERATING_SCENARIOS and AI_REVIEWER contracts and registry agents are not expressible", () => {
  const { anthropicWireSchema } = wireModule();
  for (const [name, schema] of Object.entries({
    VALUATION_CONTRACT: VALUATION_CONTRACT.schema,
    OPERATING_SCENARIOS_CONTRACT: OPERATING_SCENARIOS_CONTRACT.schema,
    AI_REVIEWER_CONTRACT: AI_REVIEWER_CONTRACT.schema,
    "metric-normalizer": (getAgentConfig("metric-normalizer").outputFormat as any).schema,
  })) {
    const before = JSON.stringify(schema);
    assert.doesNotThrow(() => unsupported(anthropicWireSchema(schema!)), name);
    assert.equal(JSON.stringify(schema), before, `${name} is not mutated`);
  }
});

test("AC-2: additionalProperties schemas and propertyNames alone make a schema inexpressible", () => {
  const { anthropicWireSchema } = wireModule();
  unsupported(anthropicWireSchema({ type: "object", properties: { tags: { type: "object", additionalProperties: { type: "string" } } } }));
  unsupported(anthropicWireSchema({ type: "object", properties: { tags: { type: "object", propertyNames: { type: "string" } } } }));
  unsupported(anthropicWireSchema({ type: "object", additionalProperties: true, properties: {} }));
});

test("AC-2: a recursive zod schema is not expressible", () => {
  const { anthropicWireSchema } = wireModule();
  const Node: z.ZodType = z.object({ label: z.string(), get children() { return z.array(Node); } });
  unsupported(anthropicWireSchema(draft7({ tree: Node })));
});

test("AC-2: 24 optional properties across nested objects pass; 25 do not", () => {
  const { anthropicWireSchema } = wireModule();
  const fields = (prefix: string, n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) =>
    [`${prefix}_${i}`, i % 2 ? z.string().optional() : z.number().default(0)]));
  const build = (inner: number) => draft7({ id: z.string(), ...fields("top", 12), nested: z.object({ key: z.string(), ...fields("inner", inner) }) });
  expressible(anthropicWireSchema(build(12)));
  unsupported(anthropicWireSchema(build(13)));
});

test("AC-2: 16 union-typed schemas (anyOf or type arrays) pass; 17 do not", () => {
  const { anthropicWireSchema } = wireModule();
  const build = (typeArrays: number) => ({
    type: "object",
    properties: {
      ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`any_${i}`, { anyOf: [{ type: "number" }, { type: "null" }] }])),
      list: {
        type: "array",
        items: { type: "object", properties: Object.fromEntries(Array.from({ length: typeArrays }, (_, i) => [`typed_${i}`, { type: ["string", "null"] }])), required: Array.from({ length: typeArrays }, (_, i) => `typed_${i}`) },
      },
    },
    required: [...Array.from({ length: 8 }, (_, i) => `any_${i}`), "list"],
  });
  expressible(anthropicWireSchema(build(8)));
  unsupported(anthropicWireSchema(build(9)));
});

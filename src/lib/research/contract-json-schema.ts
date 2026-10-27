import { z } from "zod/v4";

type JsonSchema = Record<string, unknown>;

/**
 * JSON Schema for a model output contract. It goes to providers as the structured-output format and into repair
 * prompts, so its shape is part of the model request. Zod 4.6 writes discriminated unions as `oneOf` and nullable
 * primitives as `type: [t, "null"]`; both are rewritten to `anyOf`, the form Anthropic structured outputs list as
 * supported and the one the unions limit in `anthropic-schema.ts` counts.
 */
export function contractJsonSchema(schema: z.ZodType, options: Parameters<typeof z.toJSONSchema>[1]): JsonSchema {
  return normalize(z.toJSONSchema(schema, options)) as JsonSchema;
}

function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize);
  if (!node || typeof node !== "object") return node;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "type" && Array.isArray(value)) out.anyOf = value.map((type) => ({ type }));
    else out[key === "oneOf" ? "anyOf" : key] = normalize(value);
  }
  return out;
}

/**
 * Output schemas for Anthropic structured outputs (`output_config.format`,
 * https://platform.claude.com/docs/en/build-with-claude/structured-outputs).
 *
 * The API accepts a subset of JSON Schema: every object is closed, numeric and string bounds,
 * maxItems, minItems above 1 and recursion are rejected, and a request holds at most 24 optional
 * properties and 16 union-typed schemas. The contract's zod validation still enforces every
 * constraint dropped here.
 */
import { createHash } from "node:crypto";

type Schema = Record<string, unknown>;

const STRIPPED = ["$schema", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "maxItems", "pattern"];
const FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);
const MAX_OPTIONAL = 24;
const MAX_UNIONS = 16;

const isRecord = (value: unknown): value is Schema => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Sub-schemas of a schema node. Other keywords hold data: property names, enum values, defaults. */
function children(node: Schema): Schema[] {
  const found: unknown[] = [];
  for (const key of ["properties", "definitions", "$defs", "patternProperties"]) if (isRecord(node[key])) found.push(...Object.values(node[key]));
  for (const key of ["items", "anyOf", "oneOf", "allOf", "prefixItems"]) if (Array.isArray(node[key])) found.push(...node[key]);
  for (const key of ["items", "additionalItems", "not", "contains", "if", "then", "else"]) if (isRecord(node[key])) found.push(node[key]);
  return found.filter(isRecord);
}

function resolveRef(root: Schema, ref: string): Schema | undefined {
  if (!ref.startsWith("#")) return undefined;
  let node: unknown = root;
  for (const part of ref.slice(1).split("/").slice(1)) {
    const key = decodeURIComponent(part).replace(/~1/g, "/").replace(/~0/g, "~");
    node = isRecord(node) || Array.isArray(node) ? (node as Record<string, unknown>)[key] : undefined;
  }
  return isRecord(node) ? node : undefined;
}

/** A $ref is recursive when following it reaches the same reference again; "#" always is. */
function refProblem(root: Schema, start: Schema, seen: string[]): string | undefined {
  const nodes = [start];
  for (let index = 0; index < nodes.length; index += 1) {
    const ref = nodes[index].$ref;
    if (typeof ref === "string") {
      if (seen.includes(ref)) return `recursive $ref ${ref}`;
      const target = resolveRef(root, ref);
      if (!target) return `unresolved $ref ${ref}`;
      const problem = refProblem(root, target, [...seen, ref]);
      if (problem) return problem;
    }
    nodes.push(...children(nodes[index]));
  }
  return undefined;
}

function unsupported(root: Schema): string | undefined {
  let optional = 0;
  let unions = 0;
  const nodes = [root];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node.additionalProperties === true || isRecord(node.additionalProperties)) return "open object (additionalProperties)";
    if ("propertyNames" in node) return "record (propertyNames)";
    if (isRecord(node.properties)) {
      const required = new Set(Array.isArray(node.required) ? node.required : []);
      optional += Object.keys(node.properties).filter((key) => !required.has(key)).length;
    }
    if (Array.isArray(node.anyOf) || Array.isArray(node.type)) unions += 1;
    nodes.push(...children(node));
  }
  if (optional > MAX_OPTIONAL) return `${optional} optional properties (limit ${MAX_OPTIONAL})`;
  if (unions > MAX_UNIONS) return `${unions} union-typed schemas (limit ${MAX_UNIONS})`;
  return refProblem(root, root, ["#"]);
}

function close(node: Schema) {
  for (const key of STRIPPED) delete node[key];
  if (typeof node.minItems === "number" && node.minItems > 1) delete node.minItems;
  if ("format" in node && !FORMATS.has(node.format as string)) delete node.format;
  const type = node.type;
  if (type === "object" || (Array.isArray(type) && type.includes("object")) || isRecord(node.properties)) node.additionalProperties = false;
  children(node).forEach(close);
}

/** The schema as the Anthropic API accepts it, or why it cannot be expressed. Pure; never mutates its input. */
export function anthropicWireSchema(schema: Schema): { schema: Schema } | { unsupported: string } {
  const problem = unsupported(schema);
  if (problem) return { unsupported: problem };
  const wire = structuredClone(schema);
  close(wire);
  return { schema: wire };
}

// Wire schemas the API rejected, by content, for the process lifetime.
const rejected = new Set<string>();
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : isRecord(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value) ?? "null";
const schemaHash = (schema: Schema) => createHash("sha256").update(canonical(schema), "utf8").digest("hex");

export const rememberRejectedSchema = (schema: Schema) => { rejected.add(schemaHash(schema)); };
export const isRejectedSchema = (schema: Schema) => rejected.has(schemaHash(schema));

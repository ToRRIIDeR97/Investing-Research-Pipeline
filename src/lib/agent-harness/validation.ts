export interface SchemaValidationError {
  path: string;
  message: string;
}

/** Conservative schema-directed coercions for common model JSON shape mistakes. */
export function coerceStructuredOutput(value: unknown, schemaFormat: any): { value: unknown; changed: boolean } {
  const schema = schemaFormat?.schema || schemaFormat;
  if (!schema) return { value, changed: false };

  if (schema.type === "array") {
    let arrayValue = value;
    let changed = false;
    if (typeof arrayValue === "string" && schema.items?.type === "string") {
      arrayValue = [arrayValue];
      changed = true;
    }
    if (arrayValue && typeof arrayValue === "object" && !Array.isArray(arrayValue)) {
      arrayValue = [arrayValue];
      changed = true;
    }
    if (!Array.isArray(arrayValue)) return { value, changed: false };
    const items = arrayValue.map((item) => {
      let candidate = item;
      if (typeof candidate === "string" && schema.items?.type === "object") {
        candidate = { description: candidate };
        changed = true;
      }
      const coerced = coerceStructuredOutput(candidate, schema.items);
      changed ||= coerced.changed;
      return coerced.value;
    });
    return { value: changed ? items : value, changed };
  }

  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { value, changed: false };
    const properties = schema.properties;
    if (!properties || typeof properties !== "object") return { value, changed: false };
    const output = { ...(value as Record<string, unknown>) };
    let changed = false;
    // Valuation models commonly label the protocol's formula graph as
    // `ordered_formulas`. It is structurally identical to `formulas`; accept
    // the alias locally while continuing to reject free-form expressions.
    if (!("formulas" in output) && Array.isArray(output.ordered_formulas) && "formulas" in properties) {
      output.formulas = output.ordered_formulas;
      delete output.ordered_formulas;
      changed = true;
    }
    if (!("protocol_version" in output) && "protocol_version" in properties && "method_key" in output) {
      output.protocol_version = "1.0";
      changed = true;
    }
    if (output.origin === "valuation_analyst" && "origin" in properties) {
      output.origin = "proposed";
      changed = true;
    }
    // Some providers return the source-reader's evidence fields with common
    // aliases. Normalize only the lossless aliases here; source and chunk IDs
    // remain mandatory and are never invented locally.
    const isEvidenceClaim =
      "claim_text" in properties &&
      "claim_type" in properties &&
      "claim_category" in properties &&
      "source_id" in properties &&
      "document_chunk_id" in properties;
    if (isEvidenceClaim && !("claim_text" in output) && typeof output.claim === "string") {
      output.claim_text = output.claim;
      changed = true;
    }
    if (isEvidenceClaim && !("quoted_text" in output) && typeof output.source_quote === "string") {
      output.quoted_text = output.source_quote;
      changed = true;
    }
    for (const [key, property] of Object.entries(properties)) {
      if (!(key in output)) continue;
      const coerced = coerceStructuredOutput(output[key], property);
      if (coerced.changed) {
        output[key] = coerced.value;
        changed = true;
      }
    }
    return { value: changed ? output : value, changed };
  }

  if (schema.type === "number" && typeof value === "string") {
    const label = value.trim().toLowerCase().replace(/[ -]+/g, "_");
    const labels: Record<string, number> = { very_low: 0.1, low: 0.25, medium: 0.5, moderate: 0.5, high: 0.75, very_high: 0.9 };
    const numeric = label in labels ? labels[label] : Number(value);
    if (Number.isFinite(numeric)) return { value: numeric, changed: true };
  }
  return { value, changed: false };
}

export function validateSchema(
  value: unknown,
  schemaFormat: any,
  path = ""
): SchemaValidationError[] {
  const errors: SchemaValidationError[] = [];

  // Re-unwrap schema format if nested like `{ type: "json_schema", schema: { ... } }`
  const schema = schemaFormat?.schema || schemaFormat;
  if (!schema) return errors;

  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push({ path, message: `Expected object, got ${typeof value}` });
      return errors;
    }

    const typedValue = value as Record<string, unknown>;

    if (schema.additionalProperties === false && schema.properties && typeof schema.properties === "object") {
      const allowed = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(typedValue)) {
        if (!allowed.has(key)) {
          errors.push({
            path: path ? `${path}.${key}` : key,
            message: "Additional property is not allowed",
          });
        }
      }
    }

    // Check required properties
    if (Array.isArray(schema.required)) {
      for (const requiredKey of schema.required) {
        if (!(requiredKey in typedValue) || typedValue[requiredKey] === undefined) {
          errors.push({
            path: path ? `${path}.${requiredKey}` : requiredKey,
            message: `Required property is missing`,
          });
        }
      }
    }

    // Check property schemas
    if (schema.properties && typeof schema.properties === "object") {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in typedValue && typedValue[key] !== undefined) {
          errors.push(
            ...validateSchema(
              typedValue[key],
              propSchema,
              path ? `${path}.${key}` : key
            )
          );
        }
      }
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push({ path, message: `Expected array, got ${typeof value}` });
      return errors;
    }

    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push({
        path,
        message: `Array has too few items: ${value.length} (min: ${schema.minItems})`,
      });
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push({
        path,
        message: `Array has too many items: ${value.length} (max: ${schema.maxItems})`,
      });
    }

    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        errors.push(...validateSchema(value[i], schema.items, `${path}[${i}]`));
      }
    }
  } else {
    // Validate primitive types
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    let matched = false;

    for (const t of types) {
      if (t === "string" && typeof value === "string") matched = true;
      else if (t === "number" && typeof value === "number" && Number.isFinite(value)) matched = true;
      else if (t === "boolean" && typeof value === "boolean") matched = true;
      else if (t === "null" && value === null) matched = true;
      else if (t === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) matched = true;
    }

    if (!matched) {
      errors.push({
        path,
        message: `Expected type ${JSON.stringify(schema.type)}, got ${typeof value} (${value})`,
      });
    } else {
      if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
        errors.push({
          path,
          message: `Expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`,
        });
      }
      if ("const" in schema && value !== schema.const) {
        errors.push({
          path,
          message: `Expected literal ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`,
        });
      }
    }
    if (matched && typeof value === "string") {
      if (typeof schema.minLength === "number" && value.length < schema.minLength) {
        errors.push({ path, message: `String is too short: ${value.length} (min: ${schema.minLength})` });
      }
      if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
        errors.push({ path, message: `String is too long: ${value.length} (max: ${schema.maxLength})` });
      }
    } else if (matched && typeof value === "number") {
      if (typeof schema.minimum === "number" && value < schema.minimum) {
        errors.push({ path, message: `Number is below minimum: ${value} (min: ${schema.minimum})` });
      }
      if (typeof schema.maximum === "number" && value > schema.maximum) {
        errors.push({ path, message: `Number is above maximum: ${value} (max: ${schema.maximum})` });
      }
    }
  }

  return errors;
}

export interface SchemaValidationError {
  path: string;
  message: string;
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
      else if (t === "number" && typeof value === "number") matched = true;
      else if (t === "boolean" && typeof value === "boolean") matched = true;
      else if (t === "null" && value === null) matched = true;
      else if (t === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) matched = true;
    }

    if (!matched) {
      errors.push({
        path,
        message: `Expected type ${JSON.stringify(schema.type)}, got ${typeof value} (${value})`,
      });
    }
  }

  return errors;
}

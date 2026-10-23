export function extractJsonObjects(value: string): string[] {
  const objects: string[] = [];
  const start = value.indexOf("{");
  if (start === -1) return objects;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let objectStart = -1;

  for (let i = start; i < value.length; i += 1) {
    const char = value[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) objectStart = i;
      depth += 1;
    } else if (char === "}") {
      // A stray closing brace outside any object (prose before the JSON) must not hide the objects after it.
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && objectStart !== -1) {
        objects.push(value.slice(objectStart, i + 1));
        objectStart = -1;
      }
    }
  }

  return objects;
}

/**
 * Parse a model answer. `schema` (the task's JSON schema) lets a single-root contract recover an answer that left out
 * its root key: one top-level object carrying every property the root's schema requires is wrapped under the root.
 */
export function parseStructuredOutput(text: string, requiredKeys: string[] = [], schema?: Record<string, unknown>): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  try {
    return parseCandidate(fenced?.[1] || text, requiredKeys, schema);
  } catch (error) {
    // A fence inside a JSON string (a Markdown field) cuts the "fenced" candidate short; the whole text may still parse.
    if (!fenced) throw error;
    return parseCandidate(text, requiredKeys, schema);
  }
}

/** Properties the root key's schema requires, when the contract has exactly one required root key. */
function rootRequired(schema: Record<string, unknown> | undefined, key: string): string[] | null {
  const root = (schema?.properties as Record<string, { required?: unknown }> | undefined)?.[key];
  return Array.isArray(root?.required) && root.required.length ? root.required.filter((k): k is string => typeof k === "string") : null;
}

function parseCandidate(candidate: string, requiredKeys: string[], schema?: Record<string, unknown>): unknown {
  const jsonObjects = extractJsonObjects(candidate);
  const parsedObjects: unknown[] = [];
  const matches: unknown[] = [];

  for (const json of jsonObjects) {
    try {
      const parsed = JSON.parse(json, stripNul);
      parsedObjects.push(parsed);
      if (hasRequiredKeys(parsed, requiredKeys)) matches.push(parsed);
    } catch {
      // Keep scanning
    }
  }

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error("Response contains multiple JSON objects matching the required schema keys");
  }

  if (parsedObjects.length === 1 && requiredKeys.length === 0) {
    return parsedObjects[0];
  }
  // A single-artifact answer returned without its wrapper key is that artifact; wrap it instead of repairing.
  const unwrapped = parsedObjects.length === 1 ? parsedObjects[0] as Record<string, unknown> : null;
  if (requiredKeys.length === 1 && unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped)
    && unwrapped.artifact_type === requiredKeys[0]) {
    return { [requiredKeys[0]]: unwrapped };
  }
  // The same for an answer whose own keys are the root's: every property the root's schema requires is present.
  const inner = requiredKeys.length === 1 ? rootRequired(schema, requiredKeys[0]) : null;
  if (inner) {
    const shaped = parsedObjects.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
      && inner.every((key) => key in (value as Record<string, unknown>)));
    if (shaped.length === 1) return { [requiredKeys[0]]: shaped[0] };
  }
  if (parsedObjects.length > 1 && requiredKeys.length === 0) {
    throw new Error("Response contains multiple ambiguous JSON objects");
  }

  if (parsedObjects.length > 0) {
    throw new Error(
      `JSON parsed but missing required keys: ${requiredKeys.join(", ")}`
    );
  }

  throw new Error("No valid JSON object found in response");
}

// PostgreSQL jsonb rejects U+0000, so a \u0000 escape in model output would fail persistence.
function stripNul(_key: string, value: unknown): unknown {
  return typeof value === "string" ? value.replace(/\u0000/g, "") : value;
}

function hasRequiredKeys(value: unknown, requiredKeys: string[]): boolean {
  if (requiredKeys.length === 0) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

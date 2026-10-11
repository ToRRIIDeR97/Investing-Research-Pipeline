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
      depth -= 1;
      if (depth === 0 && objectStart !== -1) {
        objects.push(value.slice(objectStart, i + 1));
        objectStart = -1;
      }
    }
  }

  return objects;
}

export function parseStructuredOutput(text: string, requiredKeys: string[] = []): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || text;

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

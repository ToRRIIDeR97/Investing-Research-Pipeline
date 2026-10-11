import type { ReportSection } from "./contracts";
import type { ReportArtifact } from "./report";

export function resolveTable(table: ReportSection["tables"][number], artifacts: ReportArtifact[]): unknown {
  const artifact = artifacts.find(a => a.id === table.artifact_id);
  if (!artifact) throw new Error(`Unknown table artifact ${table.artifact_id}`);
  let value: any = artifact.content_json;
  // Paths start inside content_json; writers sometimes name the field itself, which is the same place.
  const path = table.path?.replace(/^content_json(?:\.|$)/, "");
  for (const part of path ? path.split(".") : []) {
    if (["__proto__", "constructor", "prototype"].includes(part) || value == null || !Object.hasOwn(value, part)) {
      throw new Error(`Unknown table path ${table.path}`);
    }
    value = value[part];
  }
  return value;
}

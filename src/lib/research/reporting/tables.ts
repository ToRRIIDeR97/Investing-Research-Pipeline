import type { ReportSection } from "./contracts";
import type { ReportArtifact } from "./report";

export function resolveTable(table: ReportSection["tables"][number], artifacts: ReportArtifact[]): unknown {
  const artifact = artifacts.find(a => a.id === table.artifact_id);
  if (!artifact) throw new Error(`Unknown table artifact ${table.artifact_id}`);
  let value: any = artifact.content_json;
  for (const part of table.path ? table.path.split(".") : []) {
    if (["__proto__", "constructor", "prototype"].includes(part) || value == null || !Object.hasOwn(value, part)) {
      throw new Error(`Unknown table path ${table.path}`);
    }
    value = value[part];
  }
  return value;
}

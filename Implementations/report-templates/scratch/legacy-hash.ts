import { createReport } from "../../../src/lib/research/reporting/report";
import { artifacts, evidence, bodySection, ANALYTICS_ID, VAL_ID } from "../acceptance/fixtures";
const legacySection = (version: string) => {
  const s: any = { ...bodySection("business", ["business", "history"]), tables: [{ title: "Quarterly results", artifact_id: ANALYTICS_ID, path: "quarterly" }],
    visuals: [{ kind: "scenarios", title: "Value per share", caption: "Stored cases.", artifact_id: VAL_ID, metric: "value_per_share", unit: "USD" }] };
  delete s.exhibits;
  return createReport({ standard_version: version, asset_name: "Example Corp", cutoff: "2025-08-01T00:00:00.000Z", is_test: false,
    required_coverage: ["business", "history"], sections: [s], questions: [],
    coverage: [{ key: "business", status: "satisfied", rationale: "Covered.", section_ids: ["business"] }, { key: "history", status: "satisfied", rationale: "Covered.", section_ids: ["business"] }],
    evidence, artifacts } as any);
};
for (const v of ["asset-framework-2.1-adaptive-2", "asset-framework-2.1-adaptive-1"]) { const d = legacySection(v); console.log(v, d.standard_version, d.content_hash, d.markdown.length); }

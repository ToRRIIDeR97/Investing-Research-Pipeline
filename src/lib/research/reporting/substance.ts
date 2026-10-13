import type { ReportSection } from "./contracts";

/** Pipeline vocabulary that must not reach a reader. "Process node" and "accounting artifact" are left alone: they are domain terms. */
const INTERNAL_TERMS: [RegExp, string][] = [
  [/\bcorpus\b/i, "corpus"],
  [/\bnode[ _-](?:confidence|id|key|score)s?\b/i, "node field"],
  [/(?<!\b(?:accounting|statistical|measurement) )\bartifacts?\b/i, "artifact"],
  [/\bpackets?\b/i, "packet"],
  [/\bsupplied (?:passages?|evidence|sources?|data|claims?)\b/i, "supplied inputs"],
  [/\bconfidence(?: score| level)?(?: of| is|:|=)? ?(?:0?\.\d+|1\.0+)\b/i, "confidence score"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, "record ID"],
  [/\b[a-z]+_[a-z]+(?:_[a-z]+)*\b/, "field name"],
];

export interface SubstanceFinding {
  section_id: string; category: "writing"; severity: "medium"; source: "substance_check"; issue: string; repair: string;
}

/**
 * A deterministic floor under the AI review: an analysis paragraph must carry a figure or a citation, and
 * reader-facing text must not leak pipeline terms. Findings feed the report's writing repair; they never fail a run.
 */
export function checkReportSubstance(sections: ReportSection[]): SubstanceFinding[] {
  const findings: SubstanceFinding[] = [];
  const add = (section_id: string, issue: string, repair: string) =>
    findings.push({ section_id, category: "writing", severity: "medium", source: "substance_check", issue, repair });
  for (const s of sections) {
    s.paragraphs.forEach((p, i) => {
      if (p.kind === "analysis" && !p.evidence_ids.length && !p.artifact_ids.length && !/\d/.test(p.text))
        add(s.id, `Analysis paragraph ${i + 1} has no figure and no citation.`,
          "Ground it in a specific figure (metric, period, value) with its citation, or explain the driver behind a cited figure; otherwise remove it.");
    });
    const texts: [string, string][] = [["title", s.title], ...s.paragraphs.map((p, i): [string, string] => [`paragraph ${i + 1}`, p.text]),
      ["counterevidence", s.counterevidence], ["implication", s.implication]];
    for (const [where, text] of texts) {
      const leaked = INTERNAL_TERMS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
      if (leaked.length) add(s.id, `The ${where} uses internal pipeline terms (${leaked.join(", ")}).`,
        "Rewrite in an analyst's voice: name the filing or disclosure, say plainly what is unknown, and omit IDs, field names and confidence scores.");
    }
  }
  return findings;
}

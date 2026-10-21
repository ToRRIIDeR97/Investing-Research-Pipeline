import type { ReportSection, ResearchQuestion, CoverageCheck } from "./contracts";

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
  // Process narration seen in stored reports. Narrow on purpose: a hit forces a paid repair round.
  [/\b(?:an?|the) (?:earlier|previous|prior) draft\b/i, "draft history"],
  [/\bthe model'?s note\b/i, "model note"],
  [/\bstored (?:matrix|valuation outputs?|FCFF (?:cases|schedules?))\b/i, "stored outputs"],
  [/\bthe field is null\b/i, "null field"],
  [/\bcode (?:rebuilds|recomputes)\b/i, "code narration"],
  [/\breconciliation record\b/i, "reconciliation record"],
  [/\bcitations removed\b/i, "removed citations"],
];

export interface SubstanceFinding {
  section_id: string; category: "writing"; severity: "medium"; source: "substance_check"; issue: string; repair: string;
}

const REPAIR = "Rewrite in an analyst's voice: name the filing or disclosure, say plainly what is unknown, and omit IDs, field names, confidence scores and drafting history.";
const leaks = (text: string) => INTERNAL_TERMS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);

/**
 * A deterministic floor under the AI review: an analysis paragraph must carry a figure or a citation, and
 * reader-facing text must not leak pipeline terms. Every reader-facing field is scanned: prose, gaps, visual
 * and table titles and captions, and, when given, research questions and coverage rationales. Findings feed
 * the report's writing repair; they never fail a run.
 */
export function checkReportSubstance(sections: ReportSection[],
  extra: { questions?: ResearchQuestion[]; coverage?: CoverageCheck[] } = {}): SubstanceFinding[] {
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
      ["counterevidence", s.counterevidence], ["implication", s.implication],
      ...s.gaps.map((g, i): [string, string] => [`gap ${i + 1}`, g]),
      ...s.tables.map((t, i): [string, string] => [`table ${i + 1} title`, t.title]),
      ...(s.visuals ?? []).flatMap((v, i): [string, string][] => [[`visual ${i + 1} title`, v.title], [`visual ${i + 1} caption`, v.caption]])];
    for (const [where, text] of texts) {
      const leaked = leaks(text);
      if (leaked.length) add(s.id, `The ${where} uses internal pipeline terms (${leaked.join(", ")}).`, REPAIR);
    }
  }
  // Questions and coverage belong to the outline; their findings carry the first section they cite, or none.
  for (const q of extra.questions ?? []) {
    const leaked = leaks([q.question, q.answer, q.follow_up].join(" \n "));
    if (leaked.length) add("", `Research question "${q.id}" uses internal pipeline terms (${leaked.join(", ")}).`, REPAIR);
  }
  for (const c of extra.coverage ?? []) {
    const leaked = leaks(c.rationale);
    if (leaked.length) add(c.section_ids[0] ?? "", `The ${c.key} coverage rationale uses internal pipeline terms (${leaked.join(", ")}).`, REPAIR);
  }
  return findings;
}

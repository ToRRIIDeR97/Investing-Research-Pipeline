/**
 * The opt-in LLM judge (RUN_PAID_EVAL=1, scripts/judge-research.ts): one call per rubric dimension, given only
 * the chapters that dimension covers plus the computed report facts. It must quote the passage behind its score,
 * and code rejects quotes the report doesn't contain. It runs outside the pipeline and writes no database rows.
 */
import { z } from "zod/v4";
import { contractJsonSchema } from "@/lib/research/contract-json-schema";
import type { AgentOutputFormat } from "@/lib/agent-harness/types";
import { RUBRIC_LEVELS, type RubricDimension } from "./rubric";
import { DEPTH_CHECKS } from "../reporting/depth";

type Row = Record<string, any>;
/** Coverage keys whose chapters a dimension reads. */
const DIMENSION_COVERAGE: Record<string, string[]> = {
  framing: ["conclusion"], ownership: ["ownership", "management"], business_economics: ["business", "constraints"],
  history: ["history", "business"], cash_and_capital: ["business", "management", "history"], moat: ["moat"],
  management: ["management"], forecasts: ["forecasts", "downside"], valuation: ["valuation", "downside"],
  risk_and_monitoring: ["monitoring", "downside", "conclusion"],
};

export const JudgeScore = z.object({
  score: z.number().int().min(0).max(4),
  rationale: z.string().min(1),
  quotes: z.array(z.object({ section_id: z.string().min(1), quote: z.string().min(12).max(400) })),
  missing: z.array(z.string()),
});
export type JudgeScore = z.infer<typeof JudgeScore>;

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

export function judgePacket(dimension: RubricDimension, document: Row, artifacts: Row[]) {
  const keys = DIMENSION_COVERAGE[dimension.id] ?? [];
  const sections = (document.sections ?? []).filter((s: Row) => (s.coverage ?? []).some((k: string) => keys.includes(k)))
    .map((s: Row) => ({ id: s.id, title: s.title, paragraphs: (s.paragraphs ?? []).map((p: Row) => ({ kind: p.kind, text: p.text })),
      counterevidence: s.counterevidence, implication: s.implication, gaps: s.gaps, tables: (s.tables ?? []).map((t: Row) => t.title) }));
  const facts = artifacts.find((a) => a.artifact_type === "report_facts")?.content_json ?? null;
  return { asset: document.asset_name, cutoff: document.cutoff, dimension: { ...dimension,
      checks: DEPTH_CHECKS.filter((c) => dimension.depth_checks.includes(c.id)).map(({ id, label, ask }) => ({ id, label, ask })) },
    levels: RUBRIC_LEVELS, sections, report_facts: facts, output_contract: "research_judge" };
}

/** Quotes must be in the chapters the judge was given, so a score can't rest on invented text. */
export function judgeContract(packet: ReturnType<typeof judgePacket>): AgentOutputFormat {
  const schema = JudgeScore;
  const text = new Map<string, string>(packet.sections.map((s: Row) => [String(s.id),
    normalize([...s.paragraphs.map((p: Row) => p.text), s.counterevidence, s.implication, ...(s.gaps ?? [])].join(" "))]));
  return { requiredKeys: Object.keys(schema.shape), schema: contractJsonSchema(schema, { target: "draft-7", io: "input" }), validate(value) {
    const parsed = schema.safeParse(value);
    if (!parsed.success) return parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    if (packet.sections.length && !parsed.data.quotes.length) return [{ path: "quotes", message: "Quote at least one passage your score rests on" }];
    return parsed.data.quotes.flatMap((q, i) => text.get(q.section_id)?.includes(normalize(q.quote)) ? []
      : [{ path: `quotes.${i}`, message: `Quote not found verbatim in section ${q.section_id}` }]);
  } };
}

export const JUDGE_RULES = [
  "Score the report on this one rubric dimension from 0 to 4 using packet.levels. Level 3 is a complete preliminary initiation at the depth of the JD.com example described in dimension.anchor3; give 4 only for depth beyond it.",
  "Judge analysis, not disclosure: hedging or a stated limitation does not earn credit for analysis the report_facts show was possible.",
  "Quote, verbatim, the passages your score rests on (section_id and quote), and list in missing what a level-3 treatment would add. With no sections supplied, score 0 with no quotes.",
];

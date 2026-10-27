/**
 * Research framing: framework Stage 1 ("Define the Asset") as one model call at the research-plan stage. It names the
 * central question, what the investor owns, the economic engines and how each is valued, the key questions with
 * falsifiers, named peers and priority documents, and proposes archetypes. Everything in it is an unverified
 * hypothesis until the human approves the plan; the approved framing then rides in every analysis packet.
 */
import { z } from "zod/v4";
import { contractJsonSchema } from "@/lib/research/contract-json-schema";
import { businessArchetypes, archetypeOverlays } from "./archetypes/registry";
import { composeProfile } from "./archetypes/compose";
import { kpiArchetypes } from "./memory/needs";

const ARCHETYPE_KEYS = businessArchetypes.map((a) => a.key) as [string, ...string[]];
const OVERLAY_KEYS = archetypeOverlays.map((o) => o.key) as [string, ...string[]];
const text = (max: number) => z.string().trim().min(1).max(max);

export const ENGINE_ROLES = ["earner", "burner", "growth_investment", "option", "unclear"] as const;
export const ResearchFraming = z.object({
  central_question: text(600),
  decisive_insight_hypothesis: text(800),
  what_investor_owns: text(1200),
  engines: z.array(z.object({ name: text(120), role: z.enum(ENGINE_ROLES), value_treatment: text(400) })).min(1).max(5),
  key_questions: z.array(z.object({ id: z.string().regex(/^[a-z0-9_-]{2,40}$/), question: text(400), why_it_decides_value: text(400),
    falsifier: text(300) })).min(1).max(8),
  named_peers: z.array(z.object({ name: text(120), ticker: z.string().trim().max(12), why: text(200) })).max(6),
  priority_documents: z.array(text(200)).max(8),
  management_axes: z.array(text(200)).max(6),
  archetypes: z.array(z.object({ key: z.enum(ARCHETYPE_KEYS), reason: text(200) })).min(1).max(4),
  overlays: z.array(z.object({ key: z.enum(OVERLAY_KEYS), reason: text(200) })).max(2),
});
export type ResearchFraming = z.infer<typeof ResearchFraming>;

export function framingContract() {
  const schema = z.object({ framing: ResearchFraming });
  return { requiredKeys: ["framing"], schema: contractJsonSchema(schema, { target: "draft-7", io: "input" }),
    validate(value: unknown) {
      const parsed = schema.safeParse(value);
      if (!parsed.success) return parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
      const ids = parsed.data.framing.key_questions.map((q) => q.id);
      return new Set(ids).size === ids.length ? [] : [{ path: "framing.key_questions", message: "Key question ids must be unique" }];
    } };
}

export const FRAMING_RULES = [
  "Frame this investment before any research is collected, the way a senior analyst would at kickoff (framework Stage 1, Define the Asset). Everything you write is a hypothesis to test, not a finding: the run collects evidence afterwards.",
  "central_question is the one question that decides the investment, phrased so evidence can settle it (for example: will management let the core engine's economics accrue to shareholders while a second business burns cash). decisive_insight_hypothesis is your best guess at the reframing insight, stated so it can be proven wrong.",
  "what_investor_owns traces the claim: the security held (share class, ADS and ratio), the legal entity chain (holding company, subsidiaries, VIEs), voting versus economic control, and which assets or cash may not reach the holder.",
  "engines separates the businesses that earn from those that burn or are options; value_treatment says how each is valued (cash-flow model, loss stream, zero in base case, option). key_questions are the 3-8 questions that change value, each with a falsifier naming a metric and level that would disprove the hypothesis.",
  "named_peers are listed competitors with their ticker (empty when private); priority_documents name specific documents to collect (for example the latest proxy statement, a peer's annual report, an industry dataset). management_axes are the separate axes to score management on.",
  "archetypes and overlays choose from the listed registry keys only, with operating_company_core as the base for operating companies. human_plan_feedback, when present, is the reviewer's instruction for this redraft: follow it and keep what it does not change.",
];

/** Added to every analysis prompt whose packet carries the approved framing. */
export const FRAMING_RULE = "research_framing is the human-approved framing of this investment: central question, engines, key questions with falsifiers, named peers and management axes. They are hypotheses to test, not findings. Answer the key_questions your stage can answer, keep the named engines separate, and say when evidence contradicts a framing hypothesis.";

/** Task types that never get the framing: deterministic normalization and the framing call itself. */
export const FRAMING_EXCLUDED_TASKS = new Set(["metric_normalization", "research_framing"]);

/** The framing as packets carry it: the approved content without proposal metadata. */
export function packetFraming(framing: ResearchFraming, researchQuestion: string) {
  const rest: Partial<ResearchFraming> = { ...framing };
  delete rest.archetypes;
  delete rest.overlays;
  return { research_question: researchQuestion, ...rest };
}

export interface AssetClassification { sector?: string | null; industry?: string | null; sic?: string | number | null; sicDescription?: string | null; assetKind?: string | null }

/**
 * Archetypes from the asset's stored classification (sector, industry, SEC SIC): operating_company_core plus any specific
 * archetypes the KPI classification maps to. Financial profiles keep bank and lender. Only registry archetypes count.
 */
export function classificationArchetypes(profileKey: string | null, classification: AssetClassification): string[] {
  if (profileKey === "financials") return ["bank", "lender"];
  const specific = kpiArchetypes([], classification).filter((key) => key !== "operating_company_core" && ARCHETYPE_KEYS.includes(key) && key !== "etf_fund");
  return ["operating_company_core", ...specific.slice(0, 3)];
}

/**
 * The framing's archetype proposals added to the current composition, keeping only a combination that composes
 * without a conflict. Returns null when nothing changes.
 */
export function mergeFramingArchetypes(current: { archetypes: string[]; overlays: string[] }, framing: ResearchFraming, assetId: string) {
  const archetypes = [...new Set([...current.archetypes, ...framing.archetypes.map((a) => a.key)])];
  const overlays = [...new Set([...current.overlays, ...framing.overlays.map((o) => o.key)])];
  if (archetypes.length === current.archetypes.length && overlays.length === current.overlays.length) return null;
  const { errors } = composeProfile("framing-check", assetId, archetypes, overlays);
  return errors.length ? null : { archetypes, overlays };
}

/** Reviewer edits at the gate: a complete framing, and archetypes and overlays that compose without errors. */
export function checkGateEdits(edits: { framing?: unknown; archetypes?: unknown; overlays?: unknown }, assetId: string) {
  const framing = edits.framing === undefined ? undefined : ResearchFraming.parse(edits.framing);
  const list = (value: unknown, keys: string[], label: string) => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !keys.includes(v))) throw new Error(`${label} must be registry keys`);
    return [...new Set(value as string[])];
  };
  const archetypes = list(edits.archetypes, ARCHETYPE_KEYS, "archetypes");
  const overlays = list(edits.overlays, OVERLAY_KEYS, "overlays");
  if (archetypes) {
    const { errors } = composeProfile("gate-check", assetId, archetypes, overlays ?? []);
    if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
  }
  return { framing, archetypes, overlays };
}

export const registryChoices = () => ({ archetypes: businessArchetypes.map(({ key, name }) => ({ key, name })),
  overlays: archetypeOverlays.map(({ key, name }) => ({ key, name })) });

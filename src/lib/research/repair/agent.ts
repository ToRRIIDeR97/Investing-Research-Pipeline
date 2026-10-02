import { z } from "zod/v4";
import { callResearchAgent, exactJsonPrompt, type ResearchRunContext, type Sql } from "../run-context";
import { outputContract } from "../reporting/contracts";
import { TEAM_ROLES } from "../team-plan";
import { MODULE_CONTRACT, type ModulePacket, type ModuleWriter } from "./statement-repair";

const MODULE_OUTPUT = outputContract({ module_source: z.string().min(20).max(20000), rationale: z.string().min(1).max(2000) });

/**
 * The model sees a bounded sample; the module it writes runs on every incomplete filing.
 * Statement tables carry many facts, so small note tables are dropped from the sample.
 */
export function sampleRepairPacket(packet: ModulePacket) {
  const larger = (candidates: ModulePacket["filings"][number]["candidates"]) => {
    const kept = candidates.filter(c => c.fact_count >= 8 || c.identified_as);
    return kept.length >= 3 ? kept : candidates;
  };
  return { ...packet, filings: packet.filings.slice(0, 2).map(filing => ({ ...filing,
    candidates: larger(filing.candidates).slice(0, 40).map(c => ({ ...c,
      preceding_text: c.preceding_text.slice(-3).map(t => t.slice(0, 160)), concepts: c.concepts.slice(0, 20), row_labels: c.row_labels.slice(0, 8) })) })),
    total_filings: packet.filings.length };
}

/** The repair specialist's model call, accounted and cached like every other agent task. */
export function repairModuleWriter(sql: Sql, ctx: ResearchRunContext): ModuleWriter {
  const role = TEAM_ROLES.repair;
  return packet => callResearchAgent<{ module_source: string; rationale: string }>({ sql, ctx, stageKey: role.stage,
    taskKey: `repair:statements:${packet.previous_attempts.length + 1}`, taskType: "team_statement_repair", agentName: role.agent,
    modelTier: "mid", packet: { ...sampleRepairPacket(packet), role: "repair", output_contract: "statement_repair_module" },
    outputFormat: MODULE_OUTPUT, promptFactory: p => exactJsonPrompt({ agentName: role.agent, requiredKeys: ["module_source", "rationale"],
      packet: p, extraRules: [role.purpose, MODULE_CONTRACT,
        "The packet shows a sample of the filings; your module runs on all of them, so do not hard-code table indices.",
        "If previous_attempts lists errors, fix those specific problems."] }) });
}

// An analysis stage's artifacts written in several smaller calls instead of one (business_process_analysis, moat_analysis,
// company_genesis, operating_model). One call for every artifact spent most of its output on reasoning and was often
// cut off: on four paid SoFi runs, 11 of 29 such calls hit the output limit (model_call_logs, November 2026).
import type { AgentOutputFormat } from "@/lib/agent-harness/types";

type ValidationError = { path: string; message: string };
import type { ResearchCallParams } from "../run-context";
import { callResearchAgent, exactJsonPrompt } from "../run-context";

type Row = Record<string, any>;

/** One call of a split stage. */
export type StagePart = {
  /** Appended to the stage's task key and output contract, so each call is stored and reused on its own. */
  name: string;
  /** The stage contract's artifacts this call writes. */
  contract: AgentOutputFormat;
  /** Rules for this call, before the stage's shared rules. */
  rules: string[];
  /** Earlier parts whose accepted artifacts this call is given, under accepted_artifacts. */
  after?: string[];
  /** Extra packet keys for this call only. */
  extra?: Row;
  /** Code-owned fixes applied before the contract checks the answer (accepted: earlier parts' artifacts). */
  normalize?: (value: Row, accepted: Row) => Row;
  /** Checks against artifacts written by earlier parts (accepted), after the contract's own checks pass. */
  validate?: (value: Row, accepted: Row) => ValidationError[];
};

export type SplitStageInput = Pick<ResearchCallParams, "sql" | "ctx" | "stageKey" | "taskType" | "agentName" | "modelTier"> & {
  taskKey: string;
  /** Packet keys every call shares. */
  packet: Row;
  /** Rules every call gets, after its own. */
  rules: string[];
  parts: StagePart[];
};

const pick = (value: Row, keys: readonly string[]) => Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]]));

export function scopeRule(part: StagePart, later: string[]) {
  const own = part.contract.requiredKeys.join(", ");
  return `This call writes only ${own}.${part.after?.length ? " accepted_artifacts holds artifacts already accepted for this stage: build on them and do not restate or change them." : ""}${later.length ? ` Other calls write ${later.join(", ")}.` : ""}`;
}

/** The call a part makes, as runSplitStage sends it. Exported for a citation repair that reruns one part. */
export function partCall(input: SplitStageInput, part: StagePart, accepted: Row, overrides: { taskKey?: string; taskType?: string; extra?: Row } = {}) {
  const others = input.parts.filter((other) => other !== part).flatMap((other) => other.contract.requiredKeys);
  const given = part.after?.length ? { accepted_artifacts: pick(accepted, input.parts.filter((other) => part.after!.includes(other.name))
    .flatMap((other) => other.contract.requiredKeys)) } : {};
  const format: AgentOutputFormat = part.validate || part.normalize ? { ...part.contract, validate(value) {
    const answer = part.normalize ? part.normalize(value as Row, accepted) : value as Row;
    const errors = part.contract.validate?.(answer) || [];
    return errors.length || !part.validate ? errors : part.validate(answer, accepted);
  } } : part.contract;
  return {
    sql: input.sql, ctx: input.ctx, stageKey: input.stageKey, taskKey: overrides.taskKey ?? `${input.taskKey}:${part.name}`,
    taskType: overrides.taskType ?? input.taskType, agentName: input.agentName, modelTier: input.modelTier,
    packet: <Row>{ ...input.packet, ...part.extra, ...given, ...overrides.extra,
      output_contract: `${input.stageKey}_${part.name}`, output_schema: part.contract.schema },
    promptFactory: (p: Row) => exactJsonPrompt({ agentName: input.agentName, requiredKeys: part.contract.requiredKeys, packet: p,
      extraRules: [scopeRule(part, others), ...part.rules, ...input.rules] }),
    outputFormat: format,
  } satisfies ResearchCallParams;
}

/**
 * Runs the parts in waves: a part starts once every part it comes after has finished, and parts in the same wave run
 * side by side. Each wave settles before an error is raised, so a stage retry never overlaps a call still in flight;
 * a finished call is reused by its task key on the retry. Returns the merged artifacts.
 */
export async function runSplitStage(input: SplitStageInput): Promise<Row> {
  const accepted: Row = {};
  const done = new Set<string>();
  let pending = [...input.parts];
  while (pending.length) {
    const wave = pending.filter((part) => (part.after || []).every((name) => done.has(name)));
    if (!wave.length) throw new Error(`${input.stageKey}: parts ${pending.map((part) => part.name).join(", ")} wait on parts that never run`);
    const settled = await Promise.allSettled(wave.map(async (part) =>
      pick(await callResearchAgent<Row>(partCall(input, part, accepted)), part.contract.requiredKeys)));
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
    for (const result of settled) Object.assign(accepted, (result as PromiseFulfilledResult<Row>).value);
    for (const part of wave) done.add(part.name);
    pending = pending.filter((part) => !wave.includes(part));
  }
  return accepted;
}

import { runStatusWord } from "./run-status";

interface BriefRun {
  id: string;
  status: string;
  stages?: { stage_key: string; status: string }[];
}

/** Display the persisted gate, never infer an approval from generated prose. */
export function researchBriefAction(run: BriefRun | null, assetId: string) {
  const pipelineHref = `/assets/${assetId}/run${run ? `?run=${encodeURIComponent(run.id)}` : ""}`;
  if (!run) return { label: "Not started", tone: "neutral", action: "Start research", href: pipelineHref };
  if (run.status === "waiting_for_human") {
    const gate = run.stages?.find((stage) => stage.status === "waiting_for_human");
    if (gate?.stage_key === "research_plan") {
      return { label: "Needs plan approval", tone: "pending", action: "Review plan", href: pipelineHref };
    }
    if (gate?.stage_key === "human_review") {
      return { label: "Needs your decision", tone: "pending", action: "Review", href: `/review?run=${encodeURIComponent(run.id)}` };
    }
    return { label: "Needs your decision", tone: "pending", action: "Run details", href: pipelineHref };
  }
  // The one status vocabulary (run-status.ts), shared with the asset cards and Home.
  return {
    label: runStatusWord(run.status),
    tone: ["completed", "approved"].includes(run.status) ? "complete" : run.status === "failed" ? "error" : ["needs_more_work", "running", "queued", "pending", "planning"].includes(run.status) ? run.status : "neutral",
    action: "Run details",
    href: pipelineHref,
  };
}

interface BriefRun {
  id: string;
  status: string;
  stages?: { stage_key: string; status: string }[];
}

/** Display the persisted gate, never infer an approval from generated prose. */
export function researchBriefAction(run: BriefRun | null, assetId: string) {
  const pipelineHref = `/assets/${assetId}/run${run ? `?run=${encodeURIComponent(run.id)}` : ""}`;
  if (!run) return { label: "No research", tone: "neutral", action: "Start research", href: pipelineHref };
  if (run.status === "waiting_for_human") {
    const gate = run.stages?.find((stage) => stage.status === "waiting_for_human");
    if (gate?.stage_key === "research_plan") {
      return { label: "Needs plan approval", tone: "pending", action: "Review plan", href: pipelineHref };
    }
    if (gate?.stage_key === "human_review") {
      return { label: "Needs your decision", tone: "pending", action: "Review", href: `/review?run=${encodeURIComponent(run.id)}` };
    }
    return { label: "Awaiting input", tone: "pending", action: "Run details", href: pipelineHref };
  }
  // The same words as the asset cards and the research memo.
  const labels: Record<string, string> = { completed: "Decided", approved: "Decided", running: "Researching", queued: "Researching", pending: "Researching", planning: "Researching", needs_more_work: "Needs more work", failed: "Failed", cancelled: "Cancelled" };
  return {
    label: labels[run.status] ?? run.status.replace(/_/g, " "),
    tone: ["completed", "approved"].includes(run.status) ? "complete" : run.status === "failed" ? "error" : ["needs_more_work", "running", "queued", "pending", "planning"].includes(run.status) ? run.status : "neutral",
    action: "Run details",
    href: pipelineHref,
  };
}

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
      return { label: "Plan review pending", tone: "pending", action: "Review plan", href: pipelineHref };
    }
    if (gate?.stage_key === "human_review") {
      return { label: "Review pending", tone: "pending", action: "Review", href: `/review?run=${encodeURIComponent(run.id)}` };
    }
    return { label: "Awaiting input", tone: "pending", action: "Run details", href: pipelineHref };
  }
  const labels: Record<string, string> = { completed: "Completed", running: "In progress", failed: "Failed", cancelled: "Cancelled", queued: "Queued", pending: "Pending" };
  return {
    label: labels[run.status] ?? run.status.replace(/_/g, " "),
    tone: run.status === "completed" ? "complete" : run.status === "failed" ? "error" : "neutral",
    action: "Run details",
    href: pipelineHref,
  };
}

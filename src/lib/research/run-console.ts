export function activeRunStage<T extends { status: string }>(stages: T[]): T | undefined {
  return stages.find((stage) => stage.status === "running")
    || stages.find((stage) => stage.status === "waiting_for_human")
    || stages.find((stage) => stage.status === "pending")
    || stages.at(-1);
}

export function countOpenTaskFailures(
  tasks: Array<{ task_key: string; status: string; stage_id?: string }>,
  completedStageIds: ReadonlySet<string> = new Set()
): number {
  const stateByTask = new Map<string, string>();
  for (const task of tasks) {
    if (task.stage_id && completedStageIds.has(task.stage_id)) continue;
    const taskKey = task.task_key.replace(/:revision-\d+$/, "");
    const prior = stateByTask.get(taskKey);
    if (task.status === "completed") stateByTask.set(taskKey, "completed");
    else if (!prior || prior === "failed") stateByTask.set(taskKey, task.status);
  }
  return [...stateByTask.values()].filter((status) => status === "failed").length;
}

/** What `npm run eval:score -- ...` was asked to do; pure, so the argument rules can be tested without a database. */
export type ScoreCommand =
  | { mode: "check" }
  | { mode: "latest"; caseId?: string; write: boolean }
  | { mode: "stability"; caseId: string }
  | { mode: "all"; write: boolean }
  | { mode: "case"; caseId: string; write: boolean }
  | { mode: "runs"; runIds: string[]; write: boolean }
  | { mode: "usage" };

export const SCORE_USAGE = "Usage: npm run eval:score -- <run-id> | --case <ID> | --all | --latest [--case <ID>] | --stability <ID> | --check [--no-write]";

/**
 * Reads the arguments. --check reads only evals/scores.csv; --latest scores each case's newest completed or approved
 * run (or one case with --case). The older modes keep their precedence: --stability, --all, --case, then run ids.
 */
export function parseScoreArgs(args: string[]): ScoreCommand {
  const flag = (name: string) => args.includes(name);
  const option = (name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
  const write = !flag("--no-write");
  if (flag("--check")) return { mode: "check" };
  const caseId = option("--case"), stability = option("--stability");
  if (flag("--latest")) return caseId ? { mode: "latest", caseId, write } : { mode: "latest", write };
  if (stability) return { mode: "stability", caseId: stability };
  if (flag("--all")) return { mode: "all", write };
  if (caseId) return { mode: "case", caseId, write };
  const runIds = args.filter((a) => !a.startsWith("--"));
  return runIds.length ? { mode: "runs", runIds, write } : { mode: "usage" };
}

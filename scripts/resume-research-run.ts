import { runSystemResearchPipeline } from "../src/lib/research/system-pipeline";
import { loadResearchEnvFiles } from "../src/lib/config/research-env";

loadResearchEnvFiles();

const runId = process.env.RESEARCH_RUN_ID;
if (!runId) throw new Error("Set RESEARCH_RUN_ID to the research run to resume");

const provider = process.env.RESEARCH_ACCEPTANCE_PROVIDER || process.env.RESEARCH_MODEL_PROVIDER;
if (provider && provider !== "mock" && process.env.RUN_PAID_RESEARCH !== "1") {
  throw new Error("Set RUN_PAID_RESEARCH=1 to authorize a non-mock research run");
}
if (provider) process.env.RESEARCH_MODEL_PROVIDER = provider;

runSystemResearchPipeline(runId)
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error("Pipeline resume failed:", error);
    process.exitCode = 1;
  });

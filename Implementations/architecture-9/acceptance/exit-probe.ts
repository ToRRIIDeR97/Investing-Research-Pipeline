// Queries through both shared pools and never closes them: the process must still exit (AC-2.3).
import { sql as raw } from "drizzle-orm";
import * as pools from "../../../src/db/pipeline-sql";

async function main() {
  const { pipelineSql, pipelineDb } = pools as unknown as { pipelineSql: () => any; pipelineDb: () => any };
  const [row] = await pipelineSql()`SELECT 1 AS one`;
  await pipelineDb().execute(raw`SELECT 1`);
  if (Number(row.one) === 1) console.log("probe ok");
}

main().catch(error => { console.error(error); process.exitCode = 1; });

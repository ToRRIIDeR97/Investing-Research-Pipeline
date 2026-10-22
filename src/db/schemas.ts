// Every Drizzle schema module. The app client and the migrator share this object so they cannot drift (#17).
import * as coreSchema from "./schema/core";
import * as profilesSchema from "./schema/profiles";
import * as workflowSchema from "./schema/workflow";
import * as corpusSchema from "./schema/corpus";
import * as evidenceSchema from "./schema/evidence";
import * as metricsSchema from "./schema/metrics";
import * as valuationSchema from "./schema/valuation";
import * as thesisSchema from "./schema/thesis";
import * as aiSchema from "./schema/ai";
import * as backtestingSchema from "./schema/backtesting";
import * as researchV2Schema from "./schema/research-v2";
import * as researchArtifactsSchema from "./schema/research-artifacts";
import * as sourceIntelligenceSchema from "./schema/source-intelligence";
import * as marketDataSchema from "./schema/market-data";
import * as researchRunJobsSchema from "./schema/research-run-jobs";
import * as savedChartsSchema from "./schema/saved-charts";
import * as monitoringSchema from "./schema/monitoring";

export const schema = {
  ...coreSchema,
  ...profilesSchema,
  ...workflowSchema,
  ...corpusSchema,
  ...evidenceSchema,
  ...metricsSchema,
  ...valuationSchema,
  ...thesisSchema,
  ...aiSchema,
  ...backtestingSchema,
  ...researchV2Schema,
  ...researchArtifactsSchema,
  ...sourceIntelligenceSchema,
  ...marketDataSchema,
  ...researchRunJobsSchema,
  ...savedChartsSchema,
  ...monitoringSchema,
};

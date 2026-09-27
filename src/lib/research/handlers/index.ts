import { intakeHandler } from "./intake";
import { assetIdentityHandler } from "./asset-identity";
import { archetypeCompositionHandler } from "./archetype-composition";
import { researchPlanHandler } from "./research-plan";
import { sourceDiscoveryHandler } from "./source-discovery";
import { sourceIngestionHandler } from "./source-ingestion";
import { evidenceExtractionHandler } from "./evidence-extraction";
import { historicalRecordHandler } from "./historical-record";
import { companyGenesisHandler } from "./company-genesis";
import { historicalDiagnosisHandler } from "./historical-diagnosis";
import { businessProcessAnalysisHandler } from "./business-process-analysis";
import { moatAnalysisHandler } from "./moat-analysis";
import { operatingModelHandler } from "./operating-model";
import { operatingScenariosHandler } from "./operating-scenarios";
import { assetValuationHandler } from "./asset-valuation";
import { indicatorDesignHandler } from "./indicator-design";
import { strategyDesignHandler } from "./strategy-design";
import { backtestExecutionHandler } from "./backtest-execution";
import { backtestReviewHandler } from "./backtest-review";
import { decisionSynthesisHandler } from "./decision-synthesis";
import { aiReviewerHandler } from "./ai-reviewer";
import { humanReviewHandler } from "./human-review";
import { exportHandler } from "./export";
import { refreshScheduleHandler } from "./refresh-schedule";

import type { StageHandler } from "../run-context";

export const STAGE_HANDLERS: Record<string, StageHandler> = Object.fromEntries(
  [intakeHandler, assetIdentityHandler, archetypeCompositionHandler, researchPlanHandler, sourceDiscoveryHandler, sourceIngestionHandler, evidenceExtractionHandler, historicalRecordHandler, companyGenesisHandler, historicalDiagnosisHandler, businessProcessAnalysisHandler, moatAnalysisHandler, operatingModelHandler, operatingScenariosHandler, assetValuationHandler, indicatorDesignHandler, strategyDesignHandler, backtestExecutionHandler, backtestReviewHandler, decisionSynthesisHandler, aiReviewerHandler, humanReviewHandler, exportHandler, refreshScheduleHandler].map((handler) => [handler.stageKey, handler])
);

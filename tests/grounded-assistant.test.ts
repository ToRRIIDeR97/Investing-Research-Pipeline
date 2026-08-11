import test from "node:test";
import assert from "node:assert/strict";
import {
  buildResearchAssistantPacket,
  buildResearchAssistantPrompt,
  enforceResearchDecisionCaveat,
  type GroundedAssistantContext,
} from "../src/lib/research/grounded-assistant";

const context: GroundedAssistantContext = {
  assetName: "MercadoLibre, Inc.",
  assetKind: "equity",
  runStatus: "waiting_for_human",
  pipelineVersion: 4,
  researchQuestion: "Evaluate the business and valuation.",
  sourceCutoffAt: "2026-01-01T00:00:00.000Z",
  marketDataCutoffAt: "2026-01-01T00:00:00.000Z",
  decisionStatus: null,
  artifacts: [{ type: "investment_thesis", content: { one_sentence_thesis: "Commerce and fintech can compound if credit losses remain controlled." } }],
  theses: [{ one_sentence_thesis: "Commerce and fintech can compound if credit losses remain controlled." }],
  signals: [],
  scenarios: [
    { scenario_name: "Base", value_anchor: 2611.32 },
    { scenario_name: "Bear", value_anchor: 1410.45 },
  ],
  risks: [{ risk_name: "Credit losses", description: "Loss rates rise faster than pricing." }],
  evidence: [{ claim_text: "The company reported a disclosed operating metric." }],
  metrics: [{ metric_key: "revenue" }],
  catalysts: [],
  sources: [{ title: "Annual filing" }],
  modelCalls: [],
  conversationHistory: [
    { role: "user", content: "What is the key risk?" },
    { role: "assistant", content: "The persisted risk register is incomplete." },
  ],
  quality: {
    status: "needs_more_work",
    actionReadiness: "research_scaffold",
    errors: ["Human review decision is required before completion."],
    warnings: [],
    counts: { scenariosWithValueAnchors: 2 },
  },
};

test("assistant prompt carries live run context and the human-decision caveat", () => {
  const packet = buildResearchAssistantPacket("What is the current status?", context);
  const prompt = buildResearchAssistantPrompt("What is the current status?", context);
  assert.equal((packet as any).run.status, "waiting_for_human");
  assert.match(prompt, /No human investment decision has been recorded/);
  assert.match(prompt, /What is the key risk/);
  assert.match(prompt, /The company reported a disclosed operating metric/);
});

test("assistant caveat is enforced around model output", () => {
  const answer = enforceResearchDecisionCaveat("The base scenario has the strongest value anchor.", context);
  assert.match(answer, /base scenario/);
  assert.match(answer, /not an approved position/);
});

# Research Artifact Contracts

**Status:** Implementation contract
**Version:** 3.0.0
**Date:** 2026-07-17

This document defines every Research OS v3 artifact: purpose, producer, dependencies, JSON contract, evidence requirements, assumption requirements, validation rules, completion states, and export placement.

---

## Artifact states

```text
planned
collecting_evidence
evidence_only
draft
needs_more_work
validated
accepted
superseded
rejected
```

`evidence_only` must never satisfy an analytical completion gate.

---

## 1. `decision_context`

- **Purpose:** Record the research question, time horizon, and decision constraints.
- **Producer:** Intake stage / orchestrator.
- **Dependencies:** None.
- **Contract:**
  ```json
  {
    "research_question": "string",
    "time_horizon": "string",
    "position_sizing_constraints": "string?",
    "mandatory_considerations": ["string"],
    "timing_hypothesis": "boolean",
    "cutoff_date": "date"
  }
  ```
- **Evidence requirements:** None (user input).
- **Assumption requirements:** None.
- **Validation rules:** `research_question` non-empty; `cutoff_date` valid.
- **Completion states:** `accepted` when intake is complete.
- **Export placement:** Executive conclusion appendix.

---

## 2. `composable_research_profile`

- **Purpose:** Define the archetypes and overlays that drive the research plan.
- **Producer:** `archetype_composition` stage.
- **Dependencies:** `decision_context`, `asset_identity`.
- **Contract:**
  ```json
  {
    "asset_id": "uuid",
    "selected_archetypes": ["string"],
    "overlays": ["string"],
    "required_source_roles": ["string"],
    "required_artifacts": ["string"],
    "required_valuation_methods": ["string"],
    "forbidden_valuation_methods": ["string"],
    "human_override": { "reason": "string", "reviewed_by": "string" }?
  }
  ```
- **Evidence requirements:** Archetype selection must be supported by asset classification or public disclosure.
- **Assumption requirements:** None.
- **Validation rules:** No conflicting valuation rules; archetypes are registered; no slug-based branching.
- **Completion states:** `accepted` after `research_plan` approval.
- **Export placement:** Asset definition section.

---

## 3. `source_role_plan`

- **Purpose:** Map required source roles to planned artifacts.
- **Producer:** `source_discovery` stage.
- **Dependencies:** `composable_research_profile`.
- **Contract:**
  ```json
  {
    "roles": [
      {
        "role": "string",
        "required_for": ["string"],
        "priority": "critical | high | medium | low",
        "planned_sources": ["string"],
        "expected_availability": "date?"
      }
    ]
  }
  ```
- **Evidence requirements:** None (planning artifact).
- **Assumption requirements:** None.
- **Validation rules:** Every role in `required_source_roles` is covered.
- **Completion states:** `accepted` after research plan approval.
- **Export placement:** Evidence and source-role map.

---

## 4. `source_coverage_matrix`

- **Purpose:** Track which source roles are substantively covered by accepted documents, which are attempted, and which are gaps.
- **Producer:** `source_ingestion` stage.
- **Dependencies:** `source_role_plan`, accepted `source_documents`.
- **Contract:**
  ```json
  {
    "matrix": [
      {
        "role": "string",
        "status": "covered | attempted | gap | waived",
        "source_document_ids": ["uuid"],
        "attempt_count": "number",
        "gap": { "why_matters": "string", "what_was_attempted": "string", "why_failed": "string", "blocked_artifact": "string", "waiver_possible": "boolean" }?
      }
    ]
  }
  ```
- **Evidence requirements:** Covered roles require accepted source documents with role assignments.
- **Assumption requirements:** None.
- **Validation rules:** Candidate URLs and failed fetches cannot satisfy coverage; a single source cannot silently cover all roles unless content supports each role assignment.
- **Completion states:** `accepted` when all critical roles are covered or waived.
- **Export placement:** Evidence and source-role map.

---

## 5. `company_genesis`

- **Purpose:** Explain why the company began, the founder's motivations, the original business, and what remains relevant today.
- **Producer:** `genesis-researcher` agent.
- **Dependencies:** `source_coverage_matrix` with founder/company-history sources.
- **Contract:**
  ```json
  {
    "pre_founding_environment": "string",
    "customer_problem": "string",
    "incumbent_failure": "string",
    "enabling_change": "string",
    "founder_background": "string",
    "founder_motivation": { "primary": "string", "alternatives": ["string"], "evidence_weight": "string" },
    "original_product": "string",
    "original_customer": "string",
    "original_geography": "string",
    "original_revenue_model": "string",
    "initial_funding": "string",
    "early_constraints": "string",
    "first_proof_point": "string",
    "early_failure": "string?",
    "present_day_implications": ["string"],
    "evidence_claim_ids": ["uuid"],
    "confidence": "number"
  }
  ```
- **Evidence requirements:** Every material historical claim links to a contemporary or retrospective source, with classification.
- **Assumption requirements:** Founder motivation is supported or marked `unknown`.
- **Validation rules:** No motivation inferred solely from outcomes; alternative interpretations recorded; original vs. current business distinguished; at least one present-day implication present.
- **Completion states:** `validated` → `accepted` after reviewer checks.
- **Export placement:** Company genesis and strategic identity section.

---

## 6. `strategic_history_timeline`

- **Purpose:** Record defining pivots and strategic decisions.
- **Producer:** `genesis-researcher` agent.
- **Dependencies:** `company_genesis`.
- **Contract:**
  ```json
  {
    "events": [
      {
        "date_or_period": "string",
        "event": "string",
        "objective_at_the_time": "string",
        "decision": "string",
        "evidence_claim_ids": ["uuid"],
        "immediate_effect": "string",
        "lasting_consequence": "string",
        "strategy_changed": "boolean",
        "mission_changed": "boolean",
        "confidence": "number"
      }
    ]
  }
  ```
- **Evidence requirements:** Every event has at least one evidence claim.
- **Assumption requirements:** None.
- **Validation rules:** Every event has a date or period; confidence present; no unsupported strategic continuity claims.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Company genesis and strategic identity section.

---

## 7. `strategic_dna`

- **Purpose:** Summarize persistent strategic choices that shape current economics.
- **Producer:** `genesis-researcher` agent.
- **Dependencies:** `company_genesis`, `strategic_history_timeline`.
- **Contract:**
  ```json
  {
    "identity_statement": "string",
    "persistent_choices": ["string"],
    "what_the_company_will_not_do": ["string"],
    "evidence_claim_ids": ["uuid"],
    "confidence": "number"
  }
  ```
- **Evidence requirements:** Persistent choices must be supported by repeated actions or founder/leader statements.
- **Validation rules:** Choices must be falsifiable; no circular reasoning from outcomes.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Company genesis and strategic identity section.

---

## 8. `twenty_quarter_history`

- **Purpose:** Provide a complete, definition-aware, point-in-time historical foundation.
- **Producer:** `history-normalizer` agent / deterministic normalizer.
- **Dependencies:** `source_coverage_matrix` (filings, IR), accepted evidence claims.
- **Contract:**
  ```json
  {
    "quarters": [
      {
        "fiscal_year": "number",
        "fiscal_quarter": "number",
        "period_start": "date",
        "period_end": "date",
        "filing_date": "date",
        "available_at": "date",
        "income_statement": { "metric_key": "number" },
        "balance_sheet": { "metric_key": "number" },
        "cash_flow": { "metric_key": "number" },
        "segment_revenue": { "segment": "number" },
        "segment_profit": { "segment": "number" },
        "geographic_revenue": { "region": "number" },
        "kpi": { "metric_key": "number" }
      }
    ],
    "metadata": {
      "currency": "string",
      "unit": "string",
      "restated_version": "string?",
      "definition_reconciliations": [{ "metric_key": "string", "definition": "string", "reconciles_to": "string" }]
    }
  }
  ```
- **Evidence requirements:** Every observation links to a source document and/or evidence claim.
- **Assumption requirements:** None for reported data; estimates must be assumptions.
- **Validation rules:** At least 20 quarters accounted for; annual/quarterly reconciliation; GAAP vs. adjusted separation; segment totals reconcile to consolidated; missing values explicit.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Twenty-quarter historical record section.

---

## 9. `historical_diagnosis`

- **Purpose:** Explain what changed, when, why, and what forecast assumptions must change.
- **Producer:** `historical-diagnostician` agent.
- **Dependencies:** `twenty_quarter_history`, `business_process_map`.
- **Contract:**
  ```json
  {
    "diagnoses": [
      {
        "metric_key": "string",
        "current_level": "number",
        "historical_distribution": { "mean": "number", "median": "number", "min": "number", "max": "number", "dispersion": "number" },
        "trend": "improving | stable | deteriorating | mixed",
        "stability": "high | medium | low",
        "inflection_period": "string?",
        "causal_process_node": "string?",
        "management_control": "high | medium | low",
        "structural_cyclical_temporary_or_accounting": "string",
        "moat_implication": "string",
        "forecast_implication": "string",
        "supporting_claim_ids": ["uuid"],
        "contradicting_claim_ids": ["uuid"],
        "confidence": "number"
      }
    ]
  }
  ```
- **Evidence requirements:** Inflections and causal mechanisms require evidence.
- **Assumption requirements:** Forecast implications must be consistent with operating scenarios.
- **Validation rules:** Single-quarter structural claims require corroboration; forecast implications must be machine-readable; contradictory evidence preserved.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Historical diagnosis section.

---

## 10. `segment_model`

- **Purpose:** Model each major segment's economics.
- **Producer:** `business-model-analyst` agent.
- **Dependencies:** `twenty_quarter_history`, `historical_diagnosis`.
- **Contract:**
  ```json
  {
    "segments": [
      {
        "segment_key": "string",
        "product_or_service": "string",
        "customer_or_end_user": "string",
        "revenue_model": "string",
        "contract_structure": "string",
        "pricing_unit": "string",
        "costs_and_reinvestment": "string",
        "working_capital_mechanics": "string",
        "suppliers_complements": ["string"],
        "competitors_substitutes": ["string"],
        "regulation": "string",
        "revenue_recognition_and_cash_conversion": "string",
        "evidence_claim_ids": ["uuid"]
      }
    ]
  }
  ```
- **Evidence requirements:** Segment description and revenue model supported by filings or IR.
- **Validation rules:** Consolidated description alone is insufficient; every major segment represented; revenue-recognition chain explicit.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Segment and value-chain map section.

---

## 11. `customer_decision_map`

- **Purpose:** Map how each customer group decides to buy, stay, and switch.
- **Producer:** `customer-economics-analyst` agent.
- **Dependencies:** `segment_model`.
- **Contract:**
  ```json
  {
    "customer_groups": [
      {
        "group": "string",
        "problem": "string",
        "economic_value_or_roi": "string",
        "budget_owner": "string",
        "alternatives": ["string"],
        "purchase_criteria": ["string"],
        "deployment_constraints": "string",
        "repeat_or_renewal_mechanism": "string",
        "churn_triggers": ["string"],
        "switching_or_multi_hominging_path": "string",
        "time_to_financial_effect": "string",
        "evidence_claim_ids": ["uuid"]
      }
    ]
  }
  ```
- **Evidence requirements:** Customer claims must have primary or high-quality secondary evidence.
- **Validation rules:** Multi-homing must be recognized when applicable; switching cost claims must be evidence-based.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Customer decision processes section.

---

## 12. `business_process_map`

- **Purpose:** Model how demand becomes revenue, profit, and cash.
- **Producer:** `business-model-analyst` agent.
- **Dependencies:** `segment_model`, `customer_decision_map`.
- **Contract:**
  ```json
  {
    "process_nodes": [
      {
        "process_node": "string",
        "starting_condition": "string",
        "decision_maker": "string",
        "trigger": "string",
        "economic_incentive": "string",
        "required_resources": ["string"],
        "main_constraint": "string",
        "downside_central_upside_outcomes": { "downside": "string", "central": "string", "upside": "string" },
        "competitive_response": "string",
        "time_lag": "string",
        "financial_line_affected": "string",
        "leading_indicator": "string",
        "failure_condition": "string",
        "supporting_claim_ids": ["uuid"],
        "confidence": "number"
      }
    ]
  }
  ```
- **Evidence requirements:** Each node has supporting evidence or explicit gap.
- **Validation rules:** Time lags explicit; revenue and cash not treated as simultaneous without evidence; capacity constraints modeled.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Operational process and bottlenecks section.

---

## 13. `bottleneck_register`

- **Purpose:** Identify binding constraints that can limit forecast outcomes.
- **Producer:** `business-model-analyst` agent.
- **Dependencies:** `business_process_map`.
- **Contract:**
  ```json
  {
    "bottlenecks": [
      {
        "bottleneck": "string",
        "process_node": "string",
        "current_capacity": "number | string",
        "forecast_capacity": "number | string",
        "capacity_expansion_plan": "string",
        "capital_required": "number?",
        "time_to_expand": "string",
        "evidence_claim_ids": ["uuid"]
      }
    ]
  }
  ```
- **Evidence requirements:** Capacity and expansion claims require evidence.
- **Assumption requirements:** Expansion assumptions must be ranged.
- **Validation rules:** Forecast volume cannot exceed capacity without documented expansion.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Operational process and bottlenecks section.

---

## 14. `competitive_response_matrix`

- **Purpose:** Model competitors as active actors.
- **Producer:** `business-model-analyst` / `moat-red-teamer` agents.
- **Dependencies:** `business_process_map`, `segment_model`.
- **Contract:**
  ```json
  {
    "competitors": [
      {
        "competitor": "string",
        "competitive_position": "string",
        "likely_responses": [
          {
            "response": "string",
            "trigger": "string",
            "capital_and_time_required": "string",
            "first_vulnerable_customer": "string",
            "financial_translation": "string",
            "leading_indicators": ["string"]
          }
        ],
        "evidence_claim_ids": ["uuid"]
      }
    ]
  }
  ```
- **Evidence requirements:** Competitor actions and strategy must have evidence.
- **Validation rules:** No passive competitor assumptions; financial translation required for each response.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Competitive response section.

---

## 15. `moat_assessment`

- **Purpose:** Prove claimed moats through customer behavior, operating evidence, and historical economics.
- **Producer:** `moat-analyst` agent.
- **Dependencies:** `business_process_map`, `customer_decision_map`, `historical_diagnosis`.
- **Contract:**
  ```json
  {
    "claimed_moats": [
      {
        "moat_source": "string",
        "protected_profit_pool": "string",
        "customer_consequence": "string",
        "competitor_consequence": "string",
        "company_value_capture": "string",
        "financial_evidence": "string",
        "operating_evidence": "string",
        "maintenance_requirement": "string",
        "current_strength": "strong | moderate | weak | none",
        "durability": "long | medium | short | none",
        "decay_velocity": "string",
        "failure_indicators": ["string"],
        "evidence_claim_ids": ["uuid"],
        "confidence": "number"
      }
    ]
  }
  ```
- **Evidence requirements:** No moat inferred from growth or margins alone; financial and operating evidence required.
- **Validation rules:** Maintenance requirement explicit; decay velocity explicit; failure indicators measurable.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Moat proof, attacks, and no-moat counterfactual section.

---

## 16. `moat_attack_matrix`

- **Purpose:** Test each moat against concrete attacks.
- **Producer:** `moat-red-teamer` agent.
- **Dependencies:** `moat_assessment`.
- **Contract:**
  ```json
  {
    "attacks": [
      {
        "target_moat": "string",
        "attack": "string",
        "primary_attacker": "string",
        "attack_mechanism": "string",
        "capital_and_time_required": "string",
        "first_vulnerable_customer": "string",
        "switching_path": "string",
        "incumbent_defense": "string",
        "leading_indicators": ["string"],
        "financial_translation": "string",
        "residual_moat": "string",
        "evidence_claim_ids": ["uuid"]
      }
    ]
  }
  ```
- **Evidence requirements:** Attacks must be grounded in competitor behavior or industry dynamics.
- **Validation rules:** Every attack has financial translation and residual moat assessment.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Moat proof, attacks, and no-moat counterfactual section.

---

## 17. `no_moat_counterfactual`

- **Purpose:** Quantify economics if moats decay or never existed.
- **Producer:** `moat-red-teamer` / `forecast-analyst` agents.
- **Dependencies:** `moat_assessment`, `moat_attack_matrix`.
- **Contract:**
  ```json
  {
    "scenario_description": "string",
    "margin_impact": "string",
    "growth_impact": "string",
    "reinvestment_impact": "string",
    "valuation_impact": "string",
    "evidence_claim_ids": ["uuid"],
    "confidence": "number"
  }
  ```
- **Evidence requirements:** Based on historical evidence or comparable no-moat businesses.
- **Validation rules:** Cannot duplicate bear case without changed economics; must specify financial inputs.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Moat proof, attacks, and no-moat counterfactual section.

---

## 18. `driver_tree`

- **Purpose:** Decompose forecast inputs into operational drivers.
- **Producer:** `forecast-analyst` agent.
- **Dependencies:** `business_process_map`, `historical_diagnosis`, `bottleneck_register`.
- **Contract:**
  ```json
  {
    "drivers": [
      {
        "driver_key": "string",
        "label": "string",
        "historical_metric": "string",
        "historical_diagnosis": "string",
        "process_node": "string",
        "assumption_key": "string",
        "time_lag": "string",
        "failure_condition": "string",
        "financial_line": "string",
        "scenario_values": { "bear": "number", "base": "number", "bull": "number" }
      }
    ]
  }
  ```
- **Evidence requirements:** Historical metric and diagnosis links required.
- **Assumption requirements:** Every driver value is an assumption record.
- **Validation rules:** No material growth rate without driver path; historical basis explicit.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Driver tree and operating model section.

---

## 19. `operating_model`

- **Purpose:** Build the full financial model from drivers.
- **Producer:** `forecast-analyst` agent.
- **Dependencies:** `driver_tree`, `segment_model`, `bottleneck_register`.
- **Contract:**
  ```json
  {
    "forecast_years": ["number"],
    "line_items": [
      {
        "metric_key": "string",
        "driver_key": "string?",
        "formula": "string",
        "values": [{ "fiscal_year": "number", "value": "number" }]
      }
    ],
    "revenue_build": { "buyers": "number[]", "transactions_per_buyer": "number[]", "average_transaction_value": "number[]", "take_rate": "number[]" },
    "reinvestment": { "capex": "number[]", "r_and_d": "number[]", "sales_and_marketing": "number[]" },
    "working_capital": { "receivables_days": "number[]", "payables_days": "number[]", "inventory_days": "number[]" },
    "balance_sheet_effects": { "net_debt": "number[]", "diluted_shares": "number[]" }
  }
  ```
- **Evidence requirements:** Historical basis for each line.
- **Assumption requirements:** Every non-historical input is an assumption.
- **Validation rules:** Segment totals reconcile to consolidated; revenue build matches top line; balance sheet effects explicit.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Driver tree and operating model section.

---

## 20. `operating_scenario_set`

- **Purpose:** Define exactly one bear/base/bull operating scenario set.
- **Producer:** `forecast-analyst` agent.
- **Dependencies:** `operating_model`, `moat_assessment`, `competitive_response_matrix`.
- **Contract:**
  ```json
  {
    "scenarios": [
      {
        "scenario_type": "bear | base | bull",
        "probability": "number",
        "end_market": "string",
        "customer_economics": "string",
        "customer_spending": "string",
        "competitive_response": "string",
        "capacity": "string",
        "pricing_or_mix": "string",
        "moat_state": "strengthening | stable | decaying",
        "margin_formation": "string",
        "reinvestment": "string",
        "working_capital": "string",
        "balance_sheet": "string",
        "resulting_financial_statements": { "metric_key": "number[]" }
      }
    ]
  }
  ```
- **Evidence requirements:** Scenario states must be consistent with moat and competitive evidence.
- **Assumption requirements:** Every scenario variable is an assumption.
- **Validation rules:** Exactly one accepted set per model version; probabilities sum to 1; bear/base/bull differ by business-process outcomes, not blanket percentages; segment totals reconcile.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Operating scenarios section.

---

## 21. `top_down_bottom_up_reconciliation`

- **Purpose:** Compare top-down and bottom-up builds.
- **Producer:** `forecast-analyst` agent.
- **Dependencies:** `operating_scenario_set`.
- **Contract:**
  ```json
  {
    "top_down": { "market_size": "number", "addressable_share": "number", "company_capture": "number" },
    "bottom_up": { "customers": "number", "usage_per_customer": "number", "price": "number", "delivery_timing": "string" },
    "implied_market_size": "number",
    "implied_market_share": "number",
    "implied_customer_count": "number",
    "implied_capacity": "number",
    "capital_required": "number",
    "infrastructure_required": "string",
    "reconciliation_status": "reconciled | explained_gap | unresolved"
  }
  ```
- **Evidence requirements:** Market-size and customer-count assumptions require evidence.
- **Validation rules:** Forecast cannot exceed TAM or customer budget without documented explanation.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Top-down/bottom-up reconciliation section.

---

## 22. `reinvestment_model`

- **Purpose:** Model capital required to support scenarios.
- **Producer:** `forecast-analyst` agent.
- **Dependencies:** `operating_model`, `operating_scenario_set`.
- **Contract:**
  ```json
  {
    "capex_by_scenario": { "scenario_type": "number[]" },
    "r_and_d_by_scenario": { "scenario_type": "number[]" },
    "sales_and_marketing_by_scenario": { "scenario_type": "number[]" },
    "working_capital_by_scenario": { "scenario_type": "number[]" },
    "funding_sources": ["string"],
    "assumption_keys": ["string"]
  }
  ```
- **Evidence requirements:** Reinvestment rates anchored to history or disclosed plans.
- **Validation rules:** Capital required cannot exceed plausible funding sources without explanation.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Reinvestment economics section.

---

## 23. `valuation_method_run`

- **Purpose:** Execute an independent valuation method.
- **Producer:** `valuation-analyst` agent.
- **Dependencies:** `operating_scenario_set`, `twenty_quarter_history`.
- **Contract:**
  ```json
  {
    "method_key": "string",
    "protocol_version": "string",
    "input_manifest": { "metric_key": "value" },
    "assumptions": ["assumption_key"],
    "formulas": [{ "key": "string", "operation": "string", "args": ["string|number"], "unit": "string" }],
    "outputs": { "enterprise_value": "number?", "equity_value": "number?", "per_share_value": "number?" },
    "reproducible": "boolean"
  }
  ```
- **Evidence requirements:** Input metrics from accepted historical record or operating model.
- **Assumption requirements:** All assumptions ranged and recorded.
- **Validation rules:** Formula graph executes; no forward references; units compatible; per-share unit required for per-share value.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Valuation scenario matrix section.

---

## 24. `valuation_scenario_set`

- **Purpose:** Define valuation scenarios tied to operating scenarios.
- **Producer:** `valuation-analyst` agent.
- **Dependencies:** `valuation_method_run`.
- **Contract:**
  ```json
  {
    "scenarios": [
      {
        "scenario_type": "bear | base | bull",
        "operating_scenario_artifact_id": "uuid",
        "valuation_method_key": "string",
        "terminal_value": "number",
        "currency": "string",
        "assumptions": ["assumption_key"]
      }
    ]
  }
  ```
- **Evidence requirements:** Terminal value inputs from operating model.
- **Validation rules:** Exactly one accepted set per model version; operating and valuation assumptions independently selectable; segment SOTP reconciles.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Valuation scenario matrix section.

---

## 25. `annual_price_target_path`

- **Purpose:** Provide executable annual price targets for every forecast year through terminal.
- **Producer:** `valuation-analyst` agent.
- **Dependencies:** `valuation_scenario_set`, `operating_scenario_set`.
- **Contract:**
  ```json
  {
    "targets": [
      {
        "fiscal_year": "number",
        "scenario_type": "bear | base | bull",
        "target_date": "date",
        "price_target": "number",
        "dividend_per_share": "number?",
        "total_return_target": "number",
        "discounted_present_value": "number?",
        "valuation_method": "string",
        "operating_metric_key": "string",
        "operating_metric_value": "number",
        "valuation_parameter_key": "string",
        "valuation_parameter_value": "number",
        "net_debt": "number",
        "diluted_shares": "number",
        "currency": "string",
        "confidence": "number",
        "calculation_json": "object"
      }
    ]
  }
  ```
- **Evidence requirements:** Operating inputs from accepted operating model; valuation parameters from assumptions.
- **Validation rules:** Every year from first forecast to terminal present; final year equals terminal anchor; intermediate targets are model-derived, not interpolated; currency explicit.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Annual bear/base/bull price-target table and chart.

---

## 26. `reverse_valuation`

- **Purpose:** Translate current price into operational requirements.
- **Producer:** `valuation-analyst` agent.
- **Dependencies:** `annual_price_target_path`, market data.
- **Contract:**
  ```json
  {
    "current_price": "number",
    "currency": "string",
    "implied_metric_value": "number",
    "implied_metric_key": "string",
    "implied_growth_rate": "number",
    "implied_margin": "number",
    "sensitivity": [{ "metric_key": "string", "value_needed": "number", "current_value": "number" }],
    "conclusion": "string"
  }
  ```
- **Evidence requirements:** Current price from market data subsystem.
- **Assumption requirements:** Implied assumptions must be explicit.
- **Validation rules:** Implied values must be arithmetically derivable from current price and model.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Reverse valuation section.

---

## 27. `investment_thesis`

- **Purpose:** Synthesize the decision after operating and valuation acceptance.
- **Producer:** `decision-synthesizer` agent.
- **Dependencies:** `operating_scenario_set`, `valuation_scenario_set`, `annual_price_target_path`, `moat_assessment`.
- **Contract:**
  ```json
  {
    "one_sentence_thesis": "string",
    "causal_chain": ["string"],
    "market_missing": "string",
    "what_must_be_true": ["string"],
    "what_would_disprove": ["string"],
    "time_horizon": "string",
    "expected_return_link": "string",
    "evidence_claim_ids": ["uuid"],
    "confidence": "number"
  }
  ```
- **Evidence requirements:** Causal chain links to accepted claims.
- **Validation rules:** Generated only after operating and valuation acceptance; no generic placeholder language.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Executive conclusion and investment thesis section.

---

## 28. `risk_register`

- **Purpose:** Record genuine operating and valuation risks, not source gaps.
- **Producer:** `decision-synthesizer` agent.
- **Dependencies:** `investment_thesis`, `moat_attack_matrix`, `competitive_response_matrix`.
- **Contract:**
  ```json
  {
    "risks": [
      {
        "risk_name": "string",
        "causal_mechanism": "string",
        "probability": "number",
        "severity": "number",
        "exposure": "number",
        "leading_indicator": "string",
        "failure_threshold": "string",
        "financial_consequence": "string",
        "model_input_affected": "string",
        "mitigants": ["string"],
        "supporting_claim_ids": ["uuid"],
        "confidence": "number"
      }
    ]
  }
  ```
- **Evidence requirements:** Causal mechanism and financial consequence must be supported.
- **Validation rules:** Source gaps are not automatically business risks; placeholder language rejected.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Risks and catalysts section.

---

## 29. `catalyst_register`

- **Purpose:** Identify events or measurable transitions that could change the thesis.
- **Producer:** `decision-synthesizer` agent.
- **Dependencies:** `risk_register`, `investment_thesis`.
- **Contract:**
  ```json
  {
    "catalysts": [
      {
        "catalyst_name": "string",
        "expected_date_or_range": "string",
        "event_mechanism": "string",
        "probability": "number",
        "upside_downside": "upside | downside | both",
        "model_input_affected": "string",
        "evidence_claim_ids": ["uuid"]
      }
    ]
  }
  ```
- **Evidence requirements:** Event mechanism supported by evidence or disclosed calendar.
- **Validation rules:** A positive driver is not automatically a catalyst; expected date or range required.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Risks and catalysts section.

---

## 30. `expected_return_matrix`

- **Purpose:** Show return under each scenario and probability-weighted return.
- **Producer:** `decision-synthesizer` / `valuation-analyst` agents.
- **Dependencies:** `annual_price_target_path`, market data.
- **Contract:**
  ```json
  {
    "current_price": "number",
    "bear_return": "number",
    "base_return": "number",
    "bull_return": "number",
    "dividends_and_distributions": "number",
    "dilution": "number",
    "probability_weighted_return": "number",
    "no_rerating_return": "number",
    "strong_business_weak_stock_case": "string",
    "revenue_growth_margin_decline_case": "string",
    "maximum_plausible_permanent_loss": "number",
    "assumption_keys": ["string"]
  }
  ```
- **Evidence requirements:** Price targets from accepted valuation; current price from market data.
- **Assumption requirements:** Scenario probabilities are assumptions.
- **Validation rules:** Dilution included where material; returns calculated from executable targets.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Expected-return matrix section.

---

## 31. `thesis_breakers`

- **Purpose:** Define measurable thresholds that would invalidate the thesis.
- **Producer:** `decision-synthesizer` agent.
- **Dependencies:** `investment_thesis`, `risk_register`.
- **Contract:**
  ```json
  {
    "breakers": [
      {
        "breaker": "string",
        "threshold": "string",
        "measurement_kpi": "string",
        "model_consequence": "string",
        "evidence_claim_ids": ["uuid"]
      }
    ]
  }
  ```
- **Evidence requirements:** Threshold must be measurable.
- **Validation rules:** Every breaker has a KPI and model consequence; threshold is quantitative where possible.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Thesis breakers section.

---

## 32. `monitoring_dashboard`

- **Purpose:** Link material assumptions to KPIs with reporting frequency and thresholds.
- **Producer:** `decision-synthesizer` agent.
- **Dependencies:** `thesis_breakers`, `risk_register`, `investment_thesis`.
- **Contract:**
  ```json
  {
    "kpis": [
      {
        "kpi": "string",
        "process_node": "string",
        "current_level": "number",
        "bear_threshold": "number",
        "base_range_low": "number",
        "base_range_high": "number",
        "bull_threshold": "number",
        "reporting_frequency": "string",
        "model_input_affected": "string",
        "source_role": "string"
      }
    ]
  }
  ```
- **Evidence requirements:** Current level from accepted metric or operating model.
- **Validation rules:** Every material assumption maps to a KPI; source role for refresh identified.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Monitoring dashboard section.

---

## 33. `confidence_assessment`

- **Purpose:** Score confidence separately for each analytical area.
- **Producer:** `decision-synthesizer` agent.
- **Dependencies:** All prior artifacts.
- **Contract:**
  ```json
  {
    "scores": {
      "data": "number",
      "history": "number",
      "process": "number",
      "moat": "number",
      "forecast": "number",
      "valuation": "number",
      "downside": "number"
    },
    "lowest_area": "string",
    "limiting_factors": ["string"]
  }
  ```
- **Evidence requirements:** Scores justified by artifact states and gaps.
- **Validation rules:** Scores between 0 and 1; limiting factors explicit.
- **Completion states:** `validated` → `accepted`.
- **Export placement:** Confidence assessment section.

---

## 34. `decision_record`

- **Purpose:** Capture the human investment decision.
- **Producer:** Human reviewer / UI.
- **Dependencies:** All artifacts, AI review pass.
- **Contract:**
  ```json
  {
    "status": "approved_for_position | approved_for_tracking | watchlist | rejected | needs_more_work",
    "conviction": "high | medium | low",
    "priority": "string",
    "position_sizing_note": "string",
    "what_would_change_mind": "string",
    "open_questions": ["string"],
    "follow_up_date": "date?",
    "reviewed_by": "string",
    "reviewed_at": "timestamp"
  }
  ```
- **Evidence requirements:** None (human decision).
- **Validation rules:** Must be recorded by a human; cannot be fabricated by AI or test harness in production.
- **Completion states:** `accepted` when human review is complete.
- **Export placement:** Human decision section.

---

## 35. `ai_review_findings`

- **Purpose:** Record independent reviewer findings.
- **Producer:** `research-reviewer` agent.
- **Dependencies:** All artifacts and model audit trails.
- **Contract:**
  ```json
  {
    "findings": [
      {
        "severity": "critical | high | medium | low",
        "area": "string",
        "artifact_type": "string",
        "artifact_id": "uuid?",
        "finding": "string",
        "recommended_action": "string"
      }
    ],
    "pass_fail": "pass | needs_more_work | fail"
  }
  ```
- **Evidence requirements:** Findings reference artifact IDs and specific evidence.
- **Validation rules:** Critical findings block human review and export; definition mismatches invalidate dependent valuation.
- **Completion states:** `accepted` when pass or non-critical.
- **Export placement:** Review packet section.

---

## 36. `export_manifest`

- **Purpose:** Describe the generated export package.
- **Producer:** `export` stage.
- **Dependencies:** All accepted artifacts and quality gates.
- **Contract:**
  ```json
  {
    "schema_versions": { "artifact_schema": "string", "valuation_protocol": "string" },
    "model_versions": { "agent": "string", "prompt": "string" },
    "source_coverage": { "roles": ["string"], "gaps": ["string"] },
    "quality_gate_result": "object",
    "files": ["string"]
  }
  ```
- **Evidence requirements:** None (metadata).
- **Validation rules:** All required artifacts present or explicitly marked missing; quality gate result included.
- **Completion states:** `accepted` after export.
- **Export placement:** Package manifest.

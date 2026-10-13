# Visuals in investment research

Use a visual when it answers a question that matters to understanding the business. Keep the full reasoning and evidence available below it. A report should remain a readable research document, not a dashboard. Use at most two visuals per chapter.

Each quantitative chapter (financial history, business and segments, operating scenarios, valuation) gets one planned chart. The outline writes it to the section's `chart_plan`: the question, the visual kind and the stored data. The section writer adds that chart when the stored data supports it. Otherwise it omits the chart and adds a gap that says why. Validation rejects a section whose plan names a chart but which has neither a chart visual nor a gap mentioning the chart. Other chapters use a visual only where it explains more than prose.

## Decide before drawing

Write the question in one sentence, identify the exact supporting records, and name the takeaway. If the diagram would only repeat a paragraph without making a relationship clearer, omit it. If the evidence cannot support the takeaway, show the gap in prose.

| Reader's question | Supported visual | Required source |
| --- | --- | --- |
| How do customers, operations and money connect? | `process`, two to four nodes per lane, up to three lanes | Cited process/segment records or source passages for every lane |
| What changed in a financial measure? | `history`, a bar chart of stored observations | Exact artifact and path, one metric, unit, currency, reporting basis and periodicity |
| How did the segment mix or several measures move? | `series`, lines, or stacked bars when `stacked` is true | Same as `history`, plus two to six `lines`, each with `metric_key`, exact `segment` and `geography` (null for consolidated) and a label |
| How did a margin or other ratio move? | `ratio`, a line in percent | `numerator` and `denominator` series in the same unit, basis and periods. Code divides them |
| How do bear, base and bull differ? | `scenarios`: bars for `value_per_share` from `valuation_scenario_set`; lines per year for an `operating_scenario_set` driver (`revenue_growth`, `operating_margin`, `capex_to_revenue` …) or statement line with its `unit` | The scenario artifact. All three scenarios must have values |
| How does today's value build up? | `valuation_bridge`, a waterfall: discounted cash flows, discounted terminal value, enterprise value, net cash or debt, equity value | `valuation_scenario_set` with stored `method_inputs` and one `scenario`. Code recalculates the schedule |
| What are the people and reporting lines? | `organization` | Sourced names, roles and reporting lines |
| What must hold for a proposed advantage? | `process` with `relationship: hypothesis` | Evidence for the premise and an explicit note about the unproven link |
| What are the exact values, assumptions or unresolved details? | Existing evidence table or prose | Preserve the original records |

The renderer supports these visual types. Do not request pie charts, Sankey diagrams, arbitrary graphics or new chart kinds through improvised JSON. Add a supported type and validation before using another representation.

## Ground the content

1. Cite each process lane with `evidence_ids` or `artifact_ids`. Read the cited content: valid IDs do not establish that a relationship is true.
2. Keep node labels short and specific. Use an allowed icon: `people`, `bank`, `document`, `chart`, `building`, `technology`, or `settings`. A label and reading order must still explain the flow without an icon.
3. State limits in `note`. Use `hypothesis` for relationships that remain unproven. The renderer marks these with dashed connectors and text. Arrows have equal width and never imply measured flows.
4. Distinguish financing, cash receipts, revenue and profit. Loan-sale proceeds are not all revenue. Credit losses do not belong inside the definition of net interest income. Avoid a circular diagram that implies a self-reinforcing effect without evidence.
5. For `history`, select the stored observation series with `artifact_id`, `path`, `metric_key`, `unit`, `currency`, `reporting_basis`, and `periodicity`. Never provide a `values` array, chart points, financial calculations or coordinates. Rendering resolves the numbers directly from that artifact.
6. Do not mix segments, geography, currencies, annual/quarterly series, or accounting bases. Duplicate periods are ambiguous, not values to sum. Null observations stay missing, actual zeros remain zero, and absent periods are not interpolated. Quantitative bars include zero in the axis domain.
7. Use only observations available within the research cutoff. Preserve exact values in the underlying data table and show units beside the chart. The visible chart uses currency millions while its data table retains original precision.
8. `series`, `ratio`, `scenarios` and `valuation_bridge` follow the same rule: the model names an artifact, path and keys, and `buildVisual` in `visuals.ts` computes every number. A stacked `series` must show segments or regions of one metric without the consolidated total and without negative values. A `ratio` stays missing for a period where either input is missing or the denominator is zero or negative. `scenarios` and `valuation_bridge` refuse a withheld valuation. The bridge recalculates the stored `method_inputs` with `calculateValuationSchedule` (the FCFF schedule for that scenario when there is one) and notes the diluted share count and value per share.
9. The Markdown export writes each chart as its data table, followed by the chart's notes (for example how a ratio was calculated).

## Presentation

The app supplies colors, typography and responsive behavior. Do not ask the model for HTML, SVG, CSS, executable code or a raster chart. The workshop images are visual references; production figures use typed data, installed icons, and the existing chart library.

- Background `#fbfbf9`, text `#181818`, secondary text and links `#515d70`, muted labels `#626b78`, dividers `#e1e4e6`.
- Use whitespace and alignment. No containing cards, nested panels or shadows. Amber is reserved for pending/qualified status, not decoration.
- Do not display confidence scores, paragraph counts, IDs, SQL names or raw JSON. Keep actual research qualifications, missing evidence and decision status visible.
- Include a descriptive title, brief caption, accessible text labels and source access. Keep diagrams legible on mobile. The exact numerical data must be available without hovering.

## Model output

Write an optional `visuals` array on the section. The section writer receives the full JSON schema and the rules from `VISUAL_GUIDELINES` in `src/lib/research/reporting/visuals.ts`. The reviewer receives the same rules and must check entailment, accounting, missing data, causal claims and series comparability. Validation checks structure and reference integrity; it cannot establish semantic truth.

```json
{
  "kind": "process",
  "title": "How orders become revenue",
  "caption": "A simplified view of the documented operating process.",
  "lanes": [{
    "nodes": [{"label":"Customers","icon":"people"},{"label":"Delivery","icon":"document"},{"label":"Recognized revenue","icon":"chart"}],
    "note": "Recognition timing must match the cited accounting policy.",
    "relationship": "documented",
    "evidence_ids": ["use-an-actual-supplied-evidence-id"],
    "artifact_ids": []
  }]
}
```

A segment mix and a margin trend from the same stored observations:

```json
[{
  "kind": "series", "title": "Revenue by segment", "caption": "Annual reported revenue.",
  "artifact_id": "use-the-historical-record-id", "path": "observations",
  "unit": "USD", "currency": "USD", "reporting_basis": "gaap", "periodicity": "annual", "stacked": true,
  "lines": [
    {"label": "Segment A", "metric_key": "revenue", "segment": "exact-segment-member", "geography": null},
    {"label": "Segment B", "metric_key": "revenue", "segment": "other-segment-member", "geography": null}
  ]
}, {
  "kind": "ratio", "title": "Operating margin", "caption": "Operating income over revenue each quarter.",
  "artifact_id": "use-the-historical-record-id", "path": "observations",
  "unit": "USD", "currency": "USD", "reporting_basis": "gaap", "periodicity": "quarterly",
  "numerator": {"label": "Operating income", "metric_key": "operating_income", "segment": null, "geography": null},
  "denominator": {"label": "Revenue", "metric_key": "revenue", "segment": null, "geography": null}
}]
```

Scenario and valuation charts name only the artifact: `{"kind":"scenarios","metric":"value_per_share","unit":"","artifact_id":"…"}` or `{"kind":"valuation_bridge","scenario":"base","artifact_id":"…"}`, each with a title and caption.

These examples are structural guidance, not evidence about any company. Substitute actual supplied IDs and source-entailing labels. An empty `visuals` array is valid for a chapter without a chart plan.

## Trial on the existing SoFi report

I applied these rules locally to the existing SoFi report before handoff. This was an author trial using saved research, not a new paid model evaluation. The executable example is `src/lib/research/reporting/visual-trial.ts`.

- Business flow: deposit funding and held loans use the bank-charter passage and business-process artifact; loan sales use the cited sale-model passage; technology services use the acquisition passage plus the segment-model artifact. The technology note preserves missing pricing/contract terms. The diagram heading uses "cash moves" to avoid implying that all loan-sale proceeds are revenue.
- Funding chart: `historical_record.observations`, metric `deposits`, USD, GAAP, quarterly. It uses the full stored comparable series rather than the four illustrative dates in the workshop image. Exact observations are available below the chart.
- Trial additions are displayed only for the exact legacy report content hash. They do not rewrite the stored research, change its approval or appear on other companies' reports. Newly written reports store their visuals in sections, include them in review and hash them for approval.
- Detailed source mapping, automated results and browser comparison are recorded under `Implementations/report-visual-reader/` and in `design-qa.md`.

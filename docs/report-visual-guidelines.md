# Visuals in investment research

Use a visual when it answers a question that matters to understanding the business. Keep the full reasoning and evidence available below it. A report should remain a readable research document, not a dashboard.

Reports of standard `asset-framework-2.1-adaptive-3` split the work. **Code builds every table and chart** from stored artifacts and places them in chapters (the exhibits below). **The model draws only qualitative visuals**: `process` diagrams and `organization` charts, where a diagram explains more than prose. The outline plans no charts (it has no `chart_plan`), and the section writer returns no tables or chart specifications. If it still sends them, code drops them before storage.

## Code-built exhibits

`EXHIBITS` in `src/lib/research/reporting/exhibits.ts` is the launch catalogue. `buildExhibits` builds each exhibit from the newest artifact of its type, and `placeExhibits` puts it in the first chapter (not the conclusion) that covers its home area. If no chapter does, it goes to the first chapter that covers one of its fallbacks, in order. Each exhibit appears at most once.

| Exhibit | Kind | Home | Fallback | Stored data |
| --- | --- | --- | --- | --- |
| Quarterly results | table | history | business | `financial_analytics.quarterly`, last 8 quarters |
| Historical statistics | table | history | business | `financial_analytics.statistics` |
| Operating margin trend | chart, lines in % | history | business | `financial_analytics.quarterly`; needs 2 or more values |
| Segment economics | table | business | history | `financial_analytics.segments.annual` |
| Cash conversion | table | business | history, management | `financial_analytics.cash_conversion.quarterly`, last 8 |
| Capital allocation | table | management | business | `financial_analytics.capital_allocation.quarterly`, last 8 |
| Scenario drivers | table | forecasts | valuation | `operating_scenario_set` yearly drivers: bear, base and bull revenue growth and operating margin per year |
| Value per share by scenario | chart, bars | valuation | none | `valuation_scenario_set` value per share today, through `buildVisual` |
| Valuation bridge, base case | chart, waterfall | valuation | none | `valuation_scenario_set` base case, through `buildVisual` |
| Valuation matrix | table | valuation | none | `valuation_scenario_set.valuation_matrix` |
| Sensitivity to discount rate and terminal growth | table | valuation | downside | `valuation_scenario_set.sensitivity_grid`, discount rate by terminal growth |
| Stress cases | table | downside | valuation | `valuation_scenario_set.stress_cases` |

Rules every exhibit follows:

1. Every number comes from a stored artifact and is computed by code. Column labels are reader words: no snake_case, and acronyms in upper case.
2. Ratios show as a percent with one decimal (`39.0%`). Currency in millions is grouped with at most one decimal, and the caption names the currency (`USD millions`). Per-share values have two decimals and the caption names the price currency. Days are whole numbers and multiples read `12.3x`. A missing value shows as `—`, never as zero.
3. An exhibit whose artifact is missing or malformed, whose chart has too few points, or whose valuation is withheld (`withheldValuationReason`) is marked unavailable with a reason. It is not drawn, and the report doesn't fail.
4. A chart carries its data as a table, one row per point. The Markdown export writes the table and the notes. The report view draws the chart and keeps the table one click away.
5. The section writer receives the exhibits placed in its chapter (`section_exhibits`). It discusses them by title and draws conclusions from them without repeating every number.

The report view draws each exhibit with one tile (`src/components/report/exhibit-tile.tsx`), through `chapterExhibits`. The valuation summary (`ValuationDashboard`) and KPI health (`KPIDashboard`) tiles stay as they were.

## Qualitative visuals: decide before drawing

The model may add at most two qualitative visuals per chapter. Write the question in one sentence, identify the exact supporting records, and name the takeaway. If the diagram would only repeat a paragraph without making a relationship clearer, omit it. If the evidence cannot support the takeaway, show the gap in prose.

| Reader's question | Supported visual | Required source |
| --- | --- | --- |
| How do customers, operations and money connect? | `process`, two to four nodes per lane, up to three lanes | Cited process/segment records or source passages for every lane |
| What are the people and reporting lines? | `organization` | Sourced names, roles and reporting lines |
| What must hold for a proposed advantage? | `process` with `relationship: hypothesis` | Evidence for the premise and an explicit note about the unproven link |
| How did a measure move, how do the scenarios differ, what is it worth? | A code-built exhibit (above), discussed in prose | Stored artifacts; the writer names no paths or series |

The model may request only these two visual types. Do not request pie charts, Sankey diagrams, arbitrary graphics or quantitative charts through improvised JSON. A new quantitative view is a new code-built exhibit in `exhibits.ts`.

## Ground the content

1. Cite each process lane with `evidence_ids` or `artifact_ids`. Read the cited content: valid IDs do not establish that a relationship is true.
2. Keep node labels short and specific. Use an allowed icon: `people`, `bank`, `document`, `chart`, `building`, `technology`, or `settings`. A label and reading order must still explain the flow without an icon.
3. State limits in `note`. Use `hypothesis` for relationships that remain unproven. The renderer marks these with dashed connectors and text. Arrows have equal width and never imply measured flows.
4. Distinguish financing, cash receipts, revenue and profit. Loan-sale proceeds are not all revenue. Credit losses do not belong inside the definition of net interest income. Avoid a circular diagram that implies a self-reinforcing effect without evidence.
5. Cite with the tokens the packet uses (`ev3` for evidence, `ar2` for an artifact). Code maps them back to stored ids; an unknown token, or one of the wrong kind, is dropped and recorded in the review's `dropped_citations`. Display text never carries tokens, ids or field names: code removes them (`readerProse`) before the section is validated.

## Presentation

The app supplies colors, typography and responsive behavior. Do not ask the model for HTML, SVG, CSS, executable code or a raster chart. The workshop images are visual references; production figures use typed data, installed icons, and the existing chart library.

- Background `#fbfbf9`, text `#181818`, secondary text and links `#515d70`, muted labels `#626b78`, dividers `#e1e4e6`.
- Use whitespace and alignment. No containing cards, nested panels or shadows. Amber is reserved for pending/qualified status, not decoration.
- Do not display confidence scores, paragraph counts, IDs, SQL names or raw JSON. Keep actual research qualifications, missing evidence and decision status visible.
- Include a descriptive title, brief caption, accessible text labels and source access. Keep diagrams legible on mobile. The exact numerical data must be available without hovering.

## Model output

Write an optional `visuals` array on the section, with `process` and `organization` visuals only. The section writer receives the JSON schema and the rules from `VISUAL_GUIDELINES` in `src/lib/research/reporting/visuals.ts`, which cover those two kinds. The reviewer receives the same rules and is told the exhibits are built by code from stored data. It checks the qualitative visuals for entailment, accounting and causal claims, and checks that the prose agrees with the exhibits. Validation checks structure and reference integrity; it cannot establish semantic truth.

```json
{
  "kind": "process",
  "title": "How orders become revenue",
  "caption": "A simplified view of the documented operating process.",
  "lanes": [{
    "nodes": [{"label":"Customers","icon":"people"},{"label":"Delivery","icon":"document"},{"label":"Recognized revenue","icon":"chart"}],
    "note": "Recognition timing must match the cited accounting policy.",
    "relationship": "documented",
    "evidence_ids": ["ev3"],
    "artifact_ids": []
  }]
}
```

This example is structural guidance, not evidence about any company. Use the tokens of the supplied packet and source-entailing labels. An empty `visuals` array is valid and is the usual answer.

## Earlier reports

Reports stored under `asset-framework-2.1-adaptive-1` and `-adaptive-2` keep their own tables and charts and render exactly as before, so their content hash still verifies. In those reports the outline set a `chart_plan` on each quantitative chapter, and the section writer requested tables (`artifact_id` and `path`, flattened by `flatTable`) and chart specifications: `history`, `series`, `ratio`, `scenarios` and `valuation_bridge` named an artifact, path and keys, and `buildVisual` computed every number from the stored artifact (null observations stay missing, bars include zero, a ratio is missing where its denominator is zero or negative, and a withheld valuation draws no scenario or bridge chart). The report view still draws them through its `Exhibit` component and `sectionVisuals`, and the stored section types still parse them. New writes no longer produce them.

## Trial on the existing SoFi report

I applied these rules locally to the existing SoFi report before handoff. This was an author trial using saved research, not a new paid model evaluation. The executable example is `src/lib/research/reporting/visual-trial.ts`.

- Business flow: deposit funding and held loans use the bank-charter passage and business-process artifact; loan sales use the cited sale-model passage; technology services use the acquisition passage plus the segment-model artifact. The technology note preserves missing pricing/contract terms. The diagram heading uses "cash moves" to avoid implying that all loan-sale proceeds are revenue.
- Funding chart: `historical_record.observations`, metric `deposits`, USD, GAAP, quarterly. It uses the full stored comparable series rather than the four illustrative dates in the workshop image. Exact observations are available below the chart.
- Trial additions are displayed only for the exact legacy report content hash. They do not rewrite the stored research, change its approval or appear on other companies' reports. Newly written reports store their visuals in sections, include them in review and hash them for approval.
- Detailed source mapping, automated results and browser comparison are recorded under `Implementations/report-visual-reader/`, including `design-qa.md`.

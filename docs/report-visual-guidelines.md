# Visuals in investment research

Use a visual when it answers a question that matters to understanding the business. Keep the full reasoning and evidence available below it. A report should remain a readable research document, not a dashboard. Most chapters need no visual; use at most two per chapter.

## Decide before drawing

Write the question in one sentence, identify the exact supporting records, and name the takeaway. If the diagram would only repeat a paragraph without making a relationship clearer, omit it. If the evidence cannot support the takeaway, show the gap in prose.

| Reader's question | Supported visual | Required source |
| --- | --- | --- |
| How do customers, operations and money connect? | `process`, two to four nodes per lane, up to three lanes | Cited process/segment records or source passages for every lane |
| What changed in a financial measure? | `history`, a bar chart of stored observations | Exact artifact and path, one metric, unit, currency, reporting basis and periodicity |
| What must hold for a proposed advantage? | `process` with `relationship: hypothesis` | Evidence for the premise and an explicit note about the unproven link |
| What are the exact values, assumptions or unresolved details? | Existing evidence table or prose | Preserve the original records |

The current renderer supports these two visual types. Do not request pie charts, Sankey diagrams, arbitrary graphics or new chart kinds through improvised JSON. Add a supported type and validation before using another representation.

## Ground the content

1. Cite each process lane with `evidence_ids` or `artifact_ids`. Read the cited content: valid IDs do not establish that a relationship is true.
2. Keep node labels short and specific. Use an allowed icon: `people`, `bank`, `document`, `chart`, `building`, `technology`, or `settings`. A label and reading order must still explain the flow without an icon.
3. State limits in `note`. Use `hypothesis` for relationships that remain unproven. The renderer marks these with dashed connectors and text. Arrows have equal width and never imply measured flows.
4. Distinguish financing, cash receipts, revenue and profit. Loan-sale proceeds are not all revenue. Credit losses do not belong inside the definition of net interest income. Avoid a circular diagram that implies a self-reinforcing effect without evidence.
5. For `history`, select the stored observation series with `artifact_id`, `path`, `metric_key`, `unit`, `currency`, `reporting_basis`, and `periodicity`. Never provide a `values` array, chart points, financial calculations or coordinates. Rendering resolves the numbers directly from that artifact.
6. Do not mix segments, geography, currencies, annual/quarterly series, or accounting bases. Duplicate periods are ambiguous, not values to sum. Null observations stay missing, actual zeros remain zero, and absent periods are not interpolated. Quantitative bars include zero in the axis domain.
7. Use only observations available within the research cutoff. Preserve exact values in the underlying data table and show units beside the chart. The visible chart uses currency millions while its data table retains original precision.

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

This example is structural guidance, not evidence about any company. Substitute actual supplied IDs and source-entailing labels. An empty `visuals` array is a valid choice.

## Trial on the existing SoFi report

I applied these rules locally to the existing SoFi report before handoff. This was an author trial using saved research, not a new paid model evaluation. The executable example is `src/lib/research/reporting/visual-trial.ts`.

- Business flow: deposit funding and held loans use the bank-charter passage and business-process artifact; loan sales use the cited sale-model passage; technology services use the acquisition passage plus the segment-model artifact. The technology note preserves missing pricing/contract terms. The diagram heading uses "cash moves" to avoid implying that all loan-sale proceeds are revenue.
- Funding chart: `historical_record.observations`, metric `deposits`, USD, GAAP, quarterly. It uses the full stored comparable series rather than the four illustrative dates in the workshop image. Exact observations are available below the chart.
- Trial additions are displayed only for the exact legacy report content hash. They do not rewrite the stored research, change its approval or appear on other companies' reports. Newly written reports store their visuals in sections, include them in review and hash them for approval.
- Detailed source mapping, automated results and browser comparison are recorded under `Implementations/report-visual-reader/` and in `design-qa.md`.

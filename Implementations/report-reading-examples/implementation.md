# Report reading examples

Use the existing paid SOFI report to demonstrate two working HTML layouts. The
current full-report renderer places every object property in a table column and
stringifies nested content. Live screenshots show narrow prose columns, raw
identifiers and JSON, and a contents list that consumes a screen.

## Scope and invariants

Create static HTML/CSS/JavaScript previews under public/report-layouts, backed by
the saved report's structured sections and referenced data. Do not regenerate
research, change financial inputs, approve a report, or replace the production
page before the user can compare the examples. No dependencies or paid calls.
The root agent owns both test sets and implementation; no independent authorship
or hidden tests is claimed.

## Acceptance

- AC-1: readers see financial names such as Loan loss reserve, Net interest income
  and GAAP, never raw property names, UUIDs, JSON serialization or storage metadata.
- AC-2: historical tables retain all observations and units, distinguish zero
  from missing data, and preserve collisions rather than overwriting them. Numbers
  may be formatted with explicit units but must not be recalculated as research.
- AC-3: long records become labeled descriptions/lists; numeric comparisons remain
  tables with aligned numbers, sticky headers and a frozen first column. Table
  search, older periods, expansion, and chapter navigation must work.
- AC-4: both Reading and Analysis layouts show all 16 chapters, all paragraphs,
  counterarguments, implications, gaps and sources from the existing document.
  Repeated exhibits can point to a shared display, but must remain accessible.
- AC-5: desktop and narrow screens have no page-wide horizontal overflow. Data
  regions can scroll independently. Controls have labels, keyboard focus and
  touch-sized targets. Visible source links accept only HTTP(S).

## Direction

Reuse Kintsugi's quiet black/white chrome, with an ink-blue selection color.
Paper #fbfbf9, white #ffffff, ink #18212b, secondary #566270, line #dce2e7,
selected #204f70. Amber is reserved for the existing withheld conclusion.
Segoe UI/Inter for navigation and data; Georgia for reading-view narrative.

Reading: persistent contents rail, one comfortable prose column, supporting
exhibits accessible beside the chapter controls and within expandable sections.
Analysis: persistent chapter rail, narrative and a selected exhibit side by side.
Both need actual content and functioning controls, not decorative report cards.

## Sequence and verification

1. Capture the current page, inspect data shapes, write both test sets.
2. Build readable value/label and history projections, then the two layouts.
3. Verify all saved content is present, inspect both layouts and phone-width
   behavior with browser vision, and exercise navigation/filter/expand controls.

Commands from the repository root:

`node --test Implementations/report-reading-examples/acceptance/*.test.mjs Implementations/report-reading-examples/verification/*.test.mjs`

Acceptance covers names, record structure and history preservation. Separately
designed verification covers units, duplicates, missing values and unsafe links.
Layout and interactions require browser checks. No claim of complete accessibility
compliance will be made from screenshots alone.

## Completion

Both HTML layouts are implemented at public/report-layouts/index.html. They use
the saved report hash 61ac57651a58c24ba3214a5d4f2a87e0d56444350899a1893ce5885869d71b3e.
content-proof.json records all 16 chapters, 216 paragraphs and 98 exhibit
references across 51 unique datasets. No research was regenerated.

The two pre-implementation test sets first failed at the explicit missing-module
assertion. Four behavioral tests then passed. A fifth real-content verification
test was added after generation and passed. A label mismatch in the implementation
was corrected to the original acceptance expectation; no assertion was weakened.
`node --check public/report-layouts/report.js` passed. Five tests passed, none
skipped. Production TypeScript/database suites were not rerun for isolated static
HTML examples.

Desktop and phone-width vision, chapter navigation, layout switching, table
filtering, period navigation, expansion, safe source links, and Escape dismissal
were checked. The mobile scenario table fits without scrolling; wide historical
tables scroll inside a labeled region. No page-wide horizontal overflow was seen.
See review.md for the observed current-page problems, checks and remaining limits.

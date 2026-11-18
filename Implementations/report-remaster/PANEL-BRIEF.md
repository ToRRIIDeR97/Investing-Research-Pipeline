# Design review panel brief: Pragma Research report view

You are one of three reviewers. Rate the current design of the research report screen out of 10 and say exactly what would raise it. The owner will keep iterating until every reviewer gives at least 9, so be demanding and concrete; a 9 means "a professional analyst tool I would ship and be proud of".

## What it is
Pragma Research is a private investing research app (Next.js). A research run produces a long report on one company: 12 chapters (600-1,200 words of model-written analysis each), each with a takeaway (implication), counterarguments, evidence gaps and 0-10 data exhibits (tables or record sets from structured artifacts), plus Research questions (17) and Sources (68). The user reads it in the asset view's Report tab, and on the Reviews page beside a decision form.

## Design language it must follow ("6.01")
Clean modern SaaS, dense but ordered: grey page (#F3F4F6), flat white tiles with 1px #E5E7EB border and 8px radius, 13px base text, tabular numbers, one tile = one job, tile title row 13px semibold. Plain top nav with underline for the current item; no pills, no decorative icons, no gradients. Pragma brand: navy ink #0D1B2A, sage logo mark #75937D, blue links #2E5FA3, DM Serif Display only for page/brand titles, Inter for text, JetBrains Mono for ids. Reference prototype of the wider app: `C:\Users\sense\AppData\Local\Temp\claude\8d81828da683946c\41502014-62ba-4b7a-8a1b-dc045fbdf80b\scratchpad\canvas\project\T01-PlainTopNav.dc.html` (optional).

## What to look at
Screenshots at 1440x900 (scaled to 800 wide) in `C:\Users\sense\OneDrive\Documents\GitHub\Investing-Research-Pipeline\Implementations\report-remaster\evidence\round-<N>\` (the owner tells you N). Read every image with the Read tool. Earlier states for context: `evidence\before\` (original) .
Code if you need specifics: `src\components\research-report.tsx`, `src\components\research-report.module.css`, `src\components\report\report-panels.module.css`, `src\components\report\valuation-summary.tsx`, `src\lib\research\reporting\presentation.mjs` (repo root `C:\Users\sense\OneDrive\Documents\GitHub\Investing-Research-Pipeline`).

## Rules
Read-only: do not edit, create or delete any file, do not run the app, do not use git. Judge only what the screenshots and code show; say when something is a guess.

## Reply format (under 450 words)
1. `SCORE: n/10` on the first line (integer or .5).
2. Two or three sentences: what works.
3. Ranked list of the changes that most limit the score (most important first, at most 8). Each: the problem, where (screenshot file and element), and the concrete fix (sizes, layout, wording, behaviour). Prefer fixes the owner can make in the files above.
4. One line: what would make it a 9 or 10.

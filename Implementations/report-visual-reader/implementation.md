# Visual report reader

## Expected behavior

Apply the selected neutral business-flow design to the actual full report. Replace raw nested JSON tables with readable exhibits, keep every paragraph and source accessible, and add visuals selectively. A reader can understand how SoFi earns money, then inspect the supporting records without leaving the chapter.

The selected target is `exec-6efa4b95-ddf1-483e-b9e9-edfcebe172cc.png`. Reuse the app's off-white, charcoal and slate theme, installed Lucide icons and Recharts. No additional dependencies or paid research runs. Preserve unrelated working changes and both human review gates.

## Acceptance criteria

- AC-1: The full report supports chapter navigation, durable chapter URLs, reading/analysis modes, source dialogs and all research questions. No paragraph counts or confidence badges. Empty reports fail gracefully.
- AC-2: Tables use reader labels and recursive readable details, never raw JSON or internal IDs. Financial history preserves observations, units, missing values and exact underlying precision, with search and period navigation.
- AC-3: Writers may request at most two optional visuals per chapter: process diagrams or history charts. Diagrams cite supporting evidence/artifacts. Charts reference stored observations and never accept authored values. Bad references, unsafe paths, mixed units/bases or ambiguous duplicate periods are rejected. Plain text remains escaped by React.
- AC-4: Visual guidance is supplied to section writers and reviewers. Visual content is included in report review and approval hashing. Old reports without visuals remain compatible.
- AC-5: Try the guidance on the saved SoFi report: one sourced business-flow figure and one stored-data funding chart. Legacy additions apply only to the exact saved report hash; never infer SoFi's business for another asset. This is a local author trial, not a paid-model evaluation. Preserve original stored content and report hash.
- AC-6: Visually compare the implemented business chapter with the chosen target; check desktop and mobile, local table overflow, source keyboard dismissal, navigation and browser errors.

## Sequence and verification

1. Write acceptance and separate boundary tests before code. Both authored and run by the root agent, not hidden or independently authored.
2. Extend the optional visual contract and reuse report validation, artifact resolution and existing presentation logic.
3. Integrate the actual report reader and authored SoFi trial with source mapping.
4. Run `npx tsx --test Implementations/report-visual-reader/acceptance/*.test.ts Implementations/report-visual-reader/verification/*.test.ts`, `npx tsc --noEmit`, and the unit suite. Recheck the adaptive report tests because hashing and contracts change.
5. Browser-check the live existing report; record image comparison and interaction results in `design-qa.md` (this folder) and the task review. No approval submission, DB mutation, worker start or research regeneration is needed.

## Baseline and completion

Completed 26 September 2026. All three initial acceptance checks failed before implementation (the old contract discarded visuals, did not validate references and did not hash them). Both corrected boundary tests then failed because malformed visuals were accepted. After implementation, all eight acceptance/verification checks pass.

Type checking passes. The unit suite reports 190 passed, zero failed and three database-dependent skips. The targeted visual/adaptive-report run reports 27 passed, zero failed and one database-dependent skip. Browser evidence covers AC-1, AC-2, AC-5 and AC-6 at desktop and phone widths. See `review.md` for the local trial and `design-qa.md` for the visual review. No paid model calls or database changes were made.

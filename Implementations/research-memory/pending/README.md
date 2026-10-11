# Pending research-memory tests

These tests cover phase 3 features of the research-memory plan that are not built yet:

- AC-13 corpus questions (`acceptance-corpus.test.ts`, `verification-corpus.test.ts`): `callResearchAgent` has no `provider` option and does not answer `corpus_questions`.
- AC-15 PDF pages and AC-16 OCR client (`acceptance-pdf-ocr.test.ts`, `verification-pdf-ocr.test.ts`): `extractPdfPages` and `createOcrClient` do not exist.

They sit outside the `npm run test:db` glob (`Implementations/*/acceptance` and `Implementations/*/verification`), so that command stays green and a new research-memory regression shows as a failure. AC-14 (founder gap escalation) is built and its tests stay in `acceptance/` and `verification/`.

When one of these features is built, move its tests back next to the shared fixtures (`../acceptance/` or `../verification/`), restore the `./fixtures` import, and drop it from this list. To run them now:

```bash
RUN_DB_INTEGRATION=1 RESEARCH_MODEL_PROVIDER=mock RESEARCH_ACCEPTANCE_PROVIDER=mock npx tsx --test --test-concurrency=1 Implementations/research-memory/pending/*.test.ts
```

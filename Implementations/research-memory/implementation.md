# Research memory service

## Problem and behavior

Stages never ask the corpus a question. `buildSourcePacket` in `sources/corpus.ts` runs
one keyword query of about 40 OR'd terms over 9,000-character windows, adds the first
window of every document, and hands the source reader 18 to 32 windows for the whole
run. The founder pass gets only the first window of each founder-history document, cut
to 3,000 characters. Later stages see only the claims extracted from that packet.

The paid MercadoLibre run `d6f3fbee-d17d-450c-b397-81b635efe946` (2026-10-02,
`deepseek-v4-flash-vision-exp`, $0.038) stopped at `evidence_extraction` with "No
accepted founder/origin evidence was extracted from founder_and_company_history
sources". Its only founder source was the 2007 IPO prospectus (416 KB, 47 windows). The
first window is the cover page and table of contents. The founding story ("History of
MercadoLibre … Marcos Galper&iacute;n, our co-founder …") sits further in. The stage
retried twice with identical input. The 2026-09-29 run passed only because search also
found a short history web page.

Related defects found in the same trace:

- SEC filings are chunked as raw inline-XBRL HTML, so windows are mostly markup.
- Web pages are flattened to one line before storage, so headings are lost, and only
  five HTML entities are decoded.
- `document_embeddings`, `claim_relationships` and `research_artifact_claim_links`
  have 0 rows: the evidence graph exists in the schema but is never written.

Before: the founder pass reads the prospectus cover page and the stage fails.
After: evidence extraction asks for "founder and company origin" passages from
founder sources and receives the "History of MercadoLibre" passage with its section
path and character range. When the run's documents contain no such passage, the
collector is asked for another source before the stage fails, and the failure names
the missing need.

Architecture reference: <https://claude.ai/artifact/5zB3rZpWArSsy71BGPnR1u>. This plan
supersedes that page in one respect: vectors stay in the existing
`document_embeddings.embedding` jsonb column and are compared in application code over a
run-scoped candidate set. pgvector is not installed locally and is not required; it can
replace the comparison later behind the same function.

## Scope and invariants

New module `src/lib/research/memory/` with one public entry point, `index.ts`. Tests
import only from that entry point and from the existing functions named below.

Likely files: `sources/corpus.ts` (`storeSourcePayload`, `buildSourcePacket`,
`persistEvidence`), `sources/role-discovery.ts` (HTML and PDF payloads),
`handlers/evidence-extraction.ts`, `run-context.ts` (`callResearchAgent`),
`reporting/store.ts` and `artifacts/repository.ts` (artifact saves),
`agent-harness/registry.ts` and `providers/mock.ts` (source-reader contradiction shape),
a migration for `claim_relationships`, `.env.example`, `docs/system.md`.

Existing interfaces to reuse: `storeDiscoveredSources`, `persistEvidence`,
`saveReportArtifact`, `createArtifactRepository`, `callResearchAgent`,
`queueSourceRequests`/`SourceRequestsPending`/`processSourceRequests`,
`assertModelBudgetAvailable`/`recordModelCall`, `createSourceReaderBatches`,
`source_role_assignments` and `metadata_json.source_role` for document roles.

Invariants:

- Postgres stays the single store. No SQLite, no second index.
- Both human gates, export before refresh scheduling, and typed `research_artifacts` as
  the report source of truth are unchanged.
- Every paid model or embedding call goes through budget preflight and
  `model_call_logs`. Paid runs still require `RUN_PAID_RESEARCH=1`.
- The agent harness (`src/lib/agent-harness/`) and its prompt-cache layout are unchanged.
  Research model calls stay single-shot JSON without tools.
- SEC filing raw files keep their current format, because `history/filing-statements.ts`
  reads them.
- No new npm dependencies (`cheerio` is already a dependency). Embeddings and OCR are
  off by default.
- Existing unit, database and mock end-to-end suites keep passing.

Exclusions: pgvector indexes; letting agents call search as a tool; re-chunking every
stored document eagerly (indexing is lazy, per document, on first use); OCR of images
other than PDF pages; changes to source discovery ranking.

## Public contract

Exported from `src/lib/research/memory/index.ts`:

```ts
type BlockType = "heading" | "paragraph" | "table" | "list";
interface Passage {
  index: number;            // reading order within the document, from 0
  text: string;             // plain text; tables as "cell | cell" rows joined by "\n"
  sectionPath: string[];    // headings in effect, outermost first; [] when none
  page: number | null;      // 1-based PDF/text page from form feeds, else null
  blockTypes: BlockType[];
  charStart: number;        // offsets into the normalized document text
  charEnd: number;
}
function decodeHtmlEntities(text: string): string;
function documentPassages(content: string, mimeType: string, options?: { maxChars?: number }): Passage[];

function ensureDocumentIndexed(sql, input: { sourceId: string; runId?: string; embeddings?: EmbeddingProvider | null }):
  Promise<{ parseId: string; passages: number; status: "indexed" | "current" | "unreadable"; warnings: string[] }>;

interface RetrievalNeed {
  key: string; query: string;
  sourceRoles?: string[]; sourceIds?: string[];
  maxPassages?: number;                 // default 8
  seedClaimIds?: string[]; seedArtifactIds?: string[];
}
interface RetrievedPassage {
  passage_id: string; source_id: string; parse_id: string; source_role: string | null;
  title: string; section_path: string[]; page: number | null;
  char_start: number; char_end: number; text: string;
  score: number; matched: "keyword" | "vector" | "both" | "graph";
}
interface CoverageGap {
  need_key: string;
  reason: "no_documents_for_role" | "no_matching_passages" | "unreadable_pages";
  source_role?: string; source_id?: string; pages?: number[]; detail: string;
}
interface RetrievalResult { need_key: string; passages: RetrievedPassage[]; gaps: CoverageGap[]; ranking: "keyword" | "hybrid" }
function retrievePassages(sql, input: { runId: string; need: RetrievalNeed; embeddings?: EmbeddingProvider | null }): Promise<RetrievalResult>;

const FOUNDER_ORIGIN_NEED: RetrievalNeed;                    // key "founder_origin", sourceRoles ["founder_and_company_history"]
function evidenceNeeds(roles: string[], asset: { name: string }): RetrievalNeed[];

interface EmbeddingProvider {
  id: string; model: string; dimensions: number;
  embed(texts: string[]): Promise<{ vectors: number[][]; inputTokens: number; costUsd: number }>;
}
function getEmbeddingProvider(env?: Record<string, string | undefined>): EmbeddingProvider | null;

interface PdfPage { page: number; text: string; source: "text" | "ocr" | "none"; confidence?: number }
interface OcrClient { readPage(pdf: Uint8Array, page: number): Promise<{ text: string; confidence: number }> }
function createOcrClient(env?: Record<string, string | undefined>, fetchImpl?: typeof fetch): OcrClient | null;
function extractPdfPages(pdf: Uint8Array, options?: { ocr?: OcrClient | null }):
  Promise<{ pages: PdfPage[]; text: string; unreadablePages: number[]; lowConfidencePages: number[] }>;
```

`callResearchAgent` gains an optional `provider?: ModelProvider`, passed to
`runResearchAgent`, so tests can script model output.

## Acceptance criteria

### Phase 1: structured passages and per-need retrieval

- **AC-1 HTML structure.** `documentPassages(html, "text/html")` drops `script`,
  `style`, `head` and hidden content (`display:none` elements and `ix:header`). Elements
  with only the `hidden` attribute are kept, because streaming server rendering (React)
  delivers the page body inside `<div hidden>` containers. `h1`–`h6`
  start sections; a heading replaces headings at its level or deeper. A `p` or `div`
  whose entire text is bold (`b`, `strong`, or `font-weight: bold|700`), at most 120
  characters and not ending with a period, is a heading: level 1 when all letters are
  upper case, otherwise level 2. Text inside table cells is never a heading. Named and
  numeric entities are decoded, numeric references 128–159 map through Windows-1252
  (`&#146;` → `’`), and `&nbsp;` becomes a space. A table becomes one table block whose
  rows are `cell | cell` lines.
- **AC-2 Text and PDF structure.** For `text/plain`, a form feed starts a new page
  (pages counted from 1); without form feeds, `page` is null. A Markdown `#` line, or a
  line of at most 80 characters that has blank lines on both sides (the start of the
  document or page counts as blank), does not end in punctuation and is Title Case or
  upper case, is a heading. `application/json` content
  forms passages without headings. Empty or whitespace-only content yields no passages.
- **AC-3 Passages.** Consecutive blocks of one section merge up to `maxChars` (default
  2,400). A passage never spans two sections or two pages. A block longer than
  `maxChars` is split at sentence or table-row boundaries. The first passage of a
  section starts with its heading text. Every passage carries `sectionPath`, `page`,
  `blockTypes` and character offsets in reading order.
- **AC-4 Indexing.** Sources stored through `storeDiscoveredSources` are indexed as
  passages: a `document_parses` row with `parser_name = 'research-memory'` and
  `parser_version = '1'`, and one `document_chunks` row per passage with
  `section_title` = innermost heading (or the document title), `page_start`/`page_end`,
  `char_start`/`char_end`, and `metadata_json.section_path`. A document with only an
  older parse is indexed on first use by `ensureDocumentIndexed` from its
  `storage_path`; indexing an already indexed document returns `status: "current"`
  and adds no rows. A missing or unreadable file returns `status: "unreadable"` with a
  warning instead of throwing. SEC filing raw files are unchanged.
- **AC-5 Retrieval.** `retrievePassages` returns passages only from documents linked to
  the run (`research_run_sources` or `source_documents.research_run_id`), restricted
  to `need.sourceRoles` and `need.sourceIds` when given, using each document's latest
  `research-memory` parse (indexing it first when needed). Ranking is keyword relevance
  over passage text and section path. A passage whose section path matches the query
  ranks above passages that match only in body text. Order is deterministic, at most
  `maxPassages` are returned, and each passage carries its provenance. When the scope has
  no documents the result has a `no_documents_for_role` gap; when documents exist but
  nothing matches it has a `no_matching_passages` gap. `ranking` is `"keyword"`
  without embeddings.
- **AC-6 Evidence extraction uses needs.** The evidence-extraction packet is built from
  `evidenceNeeds` for the roles present in the run's eligible sources. Packet chunks keep
  the existing source-reader fields (`source_id`, `document_parse_id`,
  `document_chunk_id`, `source_type`, `source_role`, `title`, `section_title`,
  `chunk_index`, `char_start`, `char_end`, `content_excerpt`) and add `section_path`
  and `need`. The founder pass reads only passages returned for `FOUNDER_ORIGIN_NEED`.
  For a run whose founder source is a long prospectus with the founding story past the
  first 9,000 characters, a source-reader task packet contains the "History of
  MercadoLibre" passage, and the founder pass never receives the cover page.

### Phase 2: embeddings and the evidence graph

- **AC-7 Embedding configuration.** `getEmbeddingProvider` returns null when
  `RESEARCH_EMBEDDING_PROVIDER` is unset or `none`. `mock` returns a deterministic
  provider for tests. `openai-compatible` requires `RESEARCH_EMBEDDING_BASE_URL` (HTTPS,
  host in `RESEARCH_MODEL_ALLOWED_HOSTS`), `RESEARCH_EMBEDDING_MODEL`, and
  `RESEARCH_EMBEDDING_API_KEY` or `RESEARCH_MODEL_API_KEY`, and posts to
  `<base>/embeddings`. A missing or invalid setting throws an error naming the variable
  and never prints the key. Any other provider value throws.
- **AC-8 Embedding passages.** With a provider, indexing (including
  `ensureDocumentIndexed` on a document already indexed without embeddings) stores one
  `document_embeddings` row per passage and model (`embedding_model`,
  `embedding_dimension`, `embedding` as a number array). Requests carry at most 64 texts.
  Re-indexing adds no rows. With a `runId`, each provider call is preceded by budget
  preflight and recorded in `model_call_logs` with `agent_name = 'embedder'`, the
  provider id, model, input tokens and cost. When budget preflight or the provider fails,
  no further embedding calls are made for that document, indexing still completes
  keyword-only, and the parse `warnings_json` records the failure. Embeddings for each
  model are kept separately, so switching models adds rows for the new model.
- **AC-9 Hybrid ranking.** When the query and in-scope passages have embeddings for the
  provider's model, keyword and vector rankings are fused with reciprocal rank fusion
  (k = 60) and `ranking` is `"hybrid"`. A passage that shares no query keyword but is the
  nearest vector can be returned with `matched: "vector"`. Embeddings from another model
  are ignored. Repeated calls return the same order.
- **AC-10 Artifact citations.** Saving an artifact through `saveReportArtifact` or the
  artifact repository links each cited claim to it in `research_artifact_claim_links`
  (`support_type = 'cites'`). Cited claims are the string values, at any depth, of keys
  `evidence_ids`, `evidence_claim_ids`, `supporting_claim_ids` and `claim_ids` that
  are evidence claims of the same run. Unknown ids and other runs' claims are ignored.
  Saving identical content again adds no rows.
- **AC-11 Contradiction edges.** The source-reader contract allows `contradictions`
  entries `{claim_texts: [a, b], description, confidence}`. When `persistEvidence` stores
  both named claims from the same output, it writes a `claim_relationships` row
  (`relationship_type = 'contradicts'`) with the confidence, `extractor = 'source-reader'`,
  `extractor_version` = the source-reader prompt version, `evidence_location_ids` = both
  claims' source locations, and `review_status = 'unreviewed'`. Entries without a numeric
  confidence in [0, 1], or naming claims that were not stored, are skipped. Persisting
  the same output again adds no rows.
- **AC-12 Graph-aware retrieval.** With `seedClaimIds` or `seedArtifactIds`, passages
  that hold the seed claims (through `evidence_links` → `source_locations`) and the
  claims one `claim_relationships` hop away are included with `matched: "graph"`, even
  without a keyword match. Among passages with equal keyword rank, graph-linked
  passages come first. Relationships with `review_status = 'rejected'` are not followed.

### Phase 3: corpus questions, gap escalation and OCR

- **AC-13 Corpus questions.** A task by a stage owner in `SOURCE_REQUEST_ROLES` (not a
  `team_` task) may return an optional top-level `corpus_questions` array of at most
  three `{question, reason, source_role?}` items (question 10–300 characters).
  `callResearchAgent` answers each with `retrievePassages` over the run (and the role,
  when given), reruns the task with `team_context.corpus_answers` (question, passages,
  gaps), and returns the rerun's output without `corpus_questions`. A task chain gets
  at most two corpus rounds; after that the prompt says not to ask, and further questions
  are dropped. Invalid items and questions already answered for the stage are ignored. A
  `corpus_requests` artifact (scope = stage key) records each round's questions, the
  returned passage ids and the gaps. Replaying a completed task makes no new model call.
- **AC-14 Gap escalation.** Before spending on source-reader batches, evidence extraction
  retrieves `FOUNDER_ORIGIN_NEED`. When it has no passages and the stage has collector
  rounds left (`MAX_STAGE_SOURCE_REQUEST_ROUNDS`), the stage queues one search through
  the existing `source_requests` ledger (stage `evidence_extraction`, role `data`,
  source role `founder_and_company_history`, a query naming the asset and its founding
  history) and throws `SourceRequestsPending`. While a queued round waits for the
  collector, the stage throws `SourceRequestsPending` again without queuing another
  round. Once the need has passages (for example from a document the collector
  fetched), extraction proceeds without further requests. When the rounds are used up and the need
  still has no passages, the stage fails with a message that names `founder_origin` and
  the gap reason.
- **AC-15 PDF pages.** `extractPdfPages` keeps page boundaries: `text` joins pages with
  form feeds. Pages with no extractable text are `source: "none"` and listed in
  `unreadablePages` when OCR is off or fails. For stored `text/plain` content with form
  feeds, whitespace-only pages are unreadable: indexing records them in the parse
  warnings and `source_documents.metadata_json.unreadable_pages`. Retrieval reports
  an `unreadable_pages` gap for documents cited by a returned passage, or for every
  scoped document with unreadable pages when nothing matched. PDF tests skip when
  `pdftotext` is missing.
- **AC-16 OCR client.** `createOcrClient` returns null unless `RESEARCH_OCR_URL` is
  set. The endpoint must be HTTPS or loopback HTTP and must not contain credentials,
  a query or a fragment. The client follows the Codetonomy perception-ocr worker
  (`services/perception-ocr/server.py` at fc488e0): `PUT /v1/assets/<sha256>` with the
  PDF bytes, then `POST /v1/ocr` for the page, with `Authorization: Bearer
  $RESEARCH_OCR_TOKEN`, `modelRevision` and `parserCodeRevision` from
  `RESEARCH_OCR_MODEL_REVISION` and `RESEARCH_OCR_CODE_REVISION`. The response's block
  texts, in reading order, become the page text with `source: "ocr"` and the mean block
  confidence. Pages below 0.5 confidence are listed in `lowConfidencePages`. An OCR
  failure leaves that page unreadable without failing extraction.

## Implementation sequence

1. Phase 1, pure parsing: entity decoding, HTML/text/JSON blocks, passages (AC-1..AC-3).
2. Phase 1, storage: research-memory parse and chunks in `storeSourcePayload`, lazy
   `ensureDocumentIndexed`, HTML web pages stored with their structure (AC-4).
3. Phase 1, retrieval and evidence extraction: `retrievePassages`, `evidenceNeeds`,
   packet built from needs, founder pass on `FOUNDER_ORIGIN_NEED` (AC-5, AC-6).
   Replaces `buildSourcePacket`'s query and opening-window logic.
4. Phase 2: embedding providers and indexing with budget accounting (AC-7, AC-8), hybrid
   ranking (AC-9), migration adding `extractor`, `extractor_version`,
   `evidence_location_ids` (jsonb, default `[]`), `review_status` (default
   `unreviewed`) and a unique (from, to, type) constraint to `claim_relationships`;
   artifact citations and contradiction edges (AC-10, AC-11); graph-aware retrieval
   (AC-12).
5. Phase 3: `provider` option and corpus questions in `callResearchAgent` (AC-13);
   founder gap escalation (AC-14); PDF pages and OCR client, used by `role-discovery`
   PDF extraction (AC-15, AC-16).
6. Docs and examples: `docs/system.md` (memory service), `docs/security.md` (OCR and
   embedding endpoints), `.env.example` (new variables, all off by default).

Each phase is shippable alone. Phase 2 depends on phase 1's passages; phase 3's
corpus questions depend on phase 1's retrieval, and its graph seeds are optional.

## Verification

Working directory: repository root. Database tests need PostgreSQL with migrations
applied, `DATABASE_URL` (read from `.env.local` when unset) and `RUN_DB_INTEGRATION=1`;
they skip otherwise. They create their own assets and runs and delete them afterwards.
Run the database files one at a time, because the suites share one database.

```bash
npx tsx --test Implementations/research-memory/acceptance/*.test.ts
for f in Implementations/research-memory/acceptance/*.test.ts Implementations/research-memory/verification/*.test.ts; do RUN_DB_INTEGRATION=1 npx tsx --test "$f"; done
npx tsc --noEmit
npm run test:unit
npm run test:db
```

| Criterion | Acceptance | Verification |
|---|---|---|
| AC-1 | passages.test.ts | passages.test.ts |
| AC-2 | passages.test.ts | passages.test.ts |
| AC-3 | passages.test.ts | passages.test.ts |
| AC-4 | retrieval.test.ts (DB) | retrieval.test.ts (DB) |
| AC-5 | retrieval.test.ts (DB) | retrieval.test.ts (DB) |
| AC-6 | evidence.test.ts (DB) | evidence.test.ts (DB) |
| AC-7 | graph.test.ts | graph.test.ts |
| AC-8 | graph.test.ts (DB) | graph.test.ts (DB) |
| AC-9 | graph.test.ts (DB) | graph.test.ts (DB) |
| AC-10 | graph.test.ts (DB) | graph.test.ts (DB) |
| AC-11 | graph.test.ts (DB) | graph.test.ts (DB) |
| AC-12 | graph.test.ts (DB) | graph.test.ts (DB) |
| AC-13 | corpus.test.ts (DB) | corpus.test.ts (DB) |
| AC-14 | evidence.test.ts (DB) | evidence.test.ts (DB) |
| AC-15 | pdf-ocr.test.ts | pdf-ocr.test.ts |
| AC-16 | pdf-ocr.test.ts | pdf-ocr.test.ts |

Manual checks, not automated:

- Web pages fetched by `role-discovery` keep their HTML structure: inspect the chunks of
  one newly fetched history page for section titles.
- Resume MELI run `d6f3fbee-d17d-450c-b397-81b635efe946` from `evidence_extraction`
  after phase 1. The founder check should pass from the stored prospectus. This is a
  paid run and needs the user's approval.
- After phase 2, with a real embedding endpoint, compare keyword and hybrid results for
  the founder, segment-economics and credit-quality needs on the MELI corpus.

## Completion evidence

Fill in after implementation. Record which agent wrote the plan, the tests and the
code; the verification set is separately designed, but if one agent wrote everything it
is not independently authored.

The plan and both test sets were written by the same agent (Claude, 2026-10-02) before any
implementation. The verification set uses different fixtures, boundaries and operation
sequences, but it is not independently authored. Both sets currently live in this folder.
If a separate worker implements the plan, move `verification/` and its fixtures out of
the worker's checkout first and run it afterwards against the worker's exact revision.

Baseline (before implementation, 2026-10-02), run in a scratch checkout of `origin/main`
f2b6dc44 plus the uncommitted live-run-repair work, against the local PostgreSQL on 5432,
one file at a time with `RUN_DB_INTEGRATION=1`:

- Acceptance: 0 of 26 pass. Without the database flag, the 11 database-free tests fail
  and 15 database tests skip.
- Verification: 1 of 25 pass. "SEC filing raw files are stored byte for byte" (AC-4)
  already holds and must keep holding.
- `npx tsc --noEmit` reports no errors in `Implementations/research-memory`.
- Failure reasons, checked in the logs:
  - Tests that load the memory module fail with "src/lib/research/memory/index.ts is
    missing".
  - The corpus tests (AC-13) fail because `callResearchAgent` ignores the `provider`
    option. The mock provider answers without `answer`; no paid provider is reached,
    because both corpus files pin `RESEARCH_MODEL_PROVIDER=mock`.
  - The evidence tests fail on their own assertions: the founding story never reaches a
    source-reader packet (AC-6), and no collector request is raised (AC-14).
  - AC-10 to AC-12 stop at fixture setup with "Cannot read properties of undefined
    (reading 'id')", because no `research-memory` passages exist yet. They depend on
    AC-4.
  - The AC-15 database test fails because `metadata_json.unreadable_pages` is absent.
- The tests left no assets, runs or source documents in the database. Their storage files
  went to the scratch checkout, not the repository's `storage/`.

Test-safety rules built into the fixtures: `loadEnv` clears `RESEARCH_EMBEDDING_PROVIDER`
and `RESEARCH_OCR_URL`, so tests never reach a configured paid endpoint. Model-calling
tests pin `RESEARCH_MODEL_PROVIDER=mock`.

### Phase 1 (2026-10-02)

Implemented by the same agent that wrote the plan and tests, on branch
`feat/research-memory-phase-1` from `main` 1f91a6c5. The test files were not changed
during implementation.

- Acceptance, phase 1 files: `passages.test.ts` 5/5 and `retrieval.test.ts` 4/4.
  `evidence.test.ts` has AC-6 passing; its AC-14 case is phase 3 and still fails as
  expected.
- Verification, phase 1 files: `passages.test.ts` 7/7 and `retrieval.test.ts` 5/5.
  `evidence.test.ts` has AC-6 passing; its two AC-14 cases are phase 3 and still fail.
- `npx tsc --noEmit`: no errors outside the untracked `Temp Download/` folder.
- `npm run test:unit`: 229 pass, 0 fail, 5 skipped.
- `node scripts/test-db.cjs 'tests/*.test.ts' 'Implementations/live-run-repair/acceptance/*.test.ts'
  'Implementations/live-run-repair/verification/*.test.ts'`: 281 of 286 pass. Two failures
  happen identically on `main` without these changes, so they are not regressions:
  - live-run-repair AC-7 expects `data` among the planning roles, which
    `team-plan.ts` no longer includes.
  - `tests/research-run-harness.test.ts` has its subtests cancelled because the parent
    test finishes first.
- Real-data check, no model calls: retrieving `FOUNDER_ORIGIN_NEED` for MELI run
  `d6f3fbee` indexed the stored prospectus on first use (0.2 s) and returned the "History
  of MercadoLibre … Marcos Galperín, our co-founder" passage as the second of six. That
  prospectus was stored as one flattened line before this change, so it has no sections;
  keyword retrieval still finds the passage.
- Parse cost: the largest stored filing (12.3 MB 10-K) parses in about 1 s into 442
  passages and 150 sections, such as "PART I > Risks related to doing business in Latin
  America" and "PART II > Argentine Segment".

Decisions and limits:

- Raw `system-source-payload` chunks are still written for every source and the
  `research-memory` parse sits beside them. Valuation reads raw chunks verbatim (the
  market-data JSON and the companyfacts `"val":` lookup), so its two queries now exclude
  `research-memory` chunks. The source viewer and `/api/search` show both kinds of chunk
  until they are filtered.
- Cover pages of SEC filings produce some noise headings (for example a bold "OR").
- Web pages are stored as structured text with Markdown headings. This path was not
  exercised by an automated test; it needs a live fetch (manual check above).
- The MELI run `d6f3fbee` has not been resumed. Resuming it is a paid run.


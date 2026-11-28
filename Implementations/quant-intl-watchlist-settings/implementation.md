# Quant international, watchlist, settings, loading, storage (ten user items)

Branch `quant-intl-watchlist-settings`, base `a72856d`. One agent (TOR-1) wrote the plan, the tests and the code.

## Feature map (baseline evidence, 2026-11-28)

| # | Request | Trigger → observed failure | Cause (traced) |
|---|---|---|---|
| 10 | Apple run didn't work | Run `cd80ab15…` on asset `36caa677…` (slug `aapl`) stopped at `asset_identity`: "Asset has no primary profile". | (a) The Start-research search bar matches Yahoo results to your companies by `slug == symbol`; the seeded Apple has slug `apple` (listing AAPL), so AAPL looked new and a duplicate asset was created. (b) `POST /api/assets` never sets `primary_profile_id`, and `assetIdentityHandler` requires it, so every company added from the UI fails stage 1. |
| 7 | BBCA.JK shows nothing | `/api/quant/BBCA.JK` returns trend only: name "BBCA.JK", no PragValue ("not an SEC filer"), price 6000 shown as `$6000.00`, RS vs S&P 500. Finder search for "BBCA" returns nothing (SEC directory only); `/api/market-search` drops dotted symbols. | Fundamentals only from SEC; name only from SEC; benchmark fixed to ^GSPC; currency assumed USD; search is SEC-only. |
| 6 | PQ Grade card | Rail verdict shows "PQ-Grade · value gap and upside versus downside" under the label. | `quant-view.tsx` Rail. |
| 2 | Better PragValue/PragTrend descriptions | Finder has two one-sentence cards; ticker page has none. | Copy only. |
| 4 | Search on quant ticker page | Only `/quant` has search. | — |
| 5 | Adjust growth | Growth is fixed by `computeDcf` (base CAGR ± 30%). | DcfResult keeps per-metric cf/exits/net debt but not shares; no recompute path. |
| 8 | Watchlist | None exists. | New table. |
| 9 | Settings for models/providers | Env vars only (`RESEARCH_MODEL_PROVIDER`, `RESEARCH_*_MODEL`…), read through `process.env` at call time by the worker. | No UI or store. |
| 3 | Loading screens | ~20 plain "Loading…" strings; quant first look-up is one sentence for 20–60 s. | No shared loading component. |
| 1 | Storage | DB 351 MB (document_chunks 176, research_tasks 83, artifacts 46); `storage/` 734 MB (sources 627); `.next` 1.9 GB. `storage-gc` dry run: 431 MB reclaimable (75 SEC duplicates 287 MB, 497 unreferenced sources, 70 exports, 117 backtests). | Source files stored raw (HTML/JSON compress 5–10×); GC never applied; `.next/cache` never pruned; `quant_snapshots` keeps one row per ticker per day forever. |

## Parts

| ID | Outcome | Criteria | Files | Depends |
|---|---|---|---|---|
| P1 | A company added from Start research gets a research profile and is matched to an existing asset by listing symbol; a run on an asset without a primary profile uses the run's profile. | AC-1, AC-2, AC-3 | `src/lib/research/asset-profile.ts` (new), `src/app/api/assets/route.ts`, `src/app/research/new/page.tsx`, `src/lib/research/handlers/asset-identity.ts` | — |
| P2 | Rail verdict shows "PQ Grade" as its header, no description line. | AC-4 | `src/components/quant/quant-view.tsx` | — |
| P3 | Non-SEC listings get fundamentals from Yahoo, a name, a sector, their listing currency and a local benchmark index; the finder searches Yahoo too, so "BBCA" or "Bank Central Asia" finds BBCA.JK. | AC-5…AC-9 | `src/lib/quant/yahoo-fundamentals.ts` (new), `src/lib/quant/benchmarks.ts` (new), `src/lib/quant/inputs.ts`, `src/lib/api/quant.ts`, `src/lib/market-data/company-search.ts`, `src/app/api/quant-finder/route.ts`, quant components | — |
| P4 | Storage: source files compressed at rest (transparent reads), GC understands `.gz`, old quant snapshots pruned, `.next` cache clean script; apply only with the user's yes. | AC-10…AC-12 | `src/lib/storage/stored-file.ts` (new), readers of `storage_path`, `scripts/storage-compact.ts` (new), `src/lib/maintenance/storage-gc.ts`, `src/lib/api/quant.ts`, `package.json` | — |
| P5 | Growth levels adjustable per case on the Value tab; values recompute instantly by the same DCF math. | AC-13 | `src/lib/quant/value/model.ts`, `src/lib/quant/value/rescale.ts` (new), quant view | design |
| P6 | Watchlist: star on Quant and Research pages, list on Home and Quant finder. | AC-14, AC-15 | migration `0026`, `src/db/schema/watchlist.ts`, `src/lib/api/watchlist.ts`, `src/app/api/watchlist/**`, UI | design |
| P7 | Settings page for provider and models, stored in a gitignored local env file, applied by the worker before each job. | AC-16, AC-17 | `src/lib/settings/model-settings.ts`, `src/app/api/settings/**`, `src/app/settings/page.tsx`, worker | design |
| P8 | Designed loading states everywhere; quant first look-up shows staged progress. | AC-18 | `src/components/ui/loading.tsx`, pages | design |
| P9 | Quant ticker page has a search bar; better PragValue/PragTrend explanations. | AC-19, AC-20 | quant components | design |

## Acceptance criteria

- AC-1 `defaultProfileKeyFor(kind, sector)` maps equity→`operating_company` (Financial Services→`financials`), fund/etf→`etf_fund`, commodity→`commodity_energy`, crypto→`bitcoin` only for bitcoin else null.
- AC-2 `POST /api/assets` sets `primary_profile_id`; a slug whose ticker is listed by another asset returns 409 `DUPLICATE_LISTING` with `existing_id`. `GET /api/assets` returns each asset's listing `symbols`; the search bar treats a Yahoo symbol listed by an asset as yours.
- AC-3 `assetIdentityHandler` falls back to the run's `profile_id`, then the default profile for the asset kind, and stores it on the asset.
- AC-4 The rail verdict has a "PQ Grade" heading and no "value gap and upside versus downside" text.
- AC-5 `parseYahooFundamentals(body)` returns `AnnualFundamentals` (newest first, capex/dividends positive, tangible book derived, currency from the series, quarters from quarterly series) and `null` with no revenue years.
- AC-6 `benchmarkFor("BBCA.JK")` is `^JKSE`; `.L`→`^FTSE`, `.T`→`^N225`, `.HK`→`^HSI`, `.TO`→`^GSPTSE`, `.AX`→`^AXJO`, `.SI`→`^STI`, `.NS`/`.BO`→`^NSEI`/`^BSESN`, `.DE`→`^GDAXI`, `.PA`→`^FCHI`, `.KS`→`^KS11`; bare US ticker → `^GSPC`.
- AC-7 Snapshot carries `currency` and `benchmark` `{symbol,name}`; money in the quant view uses the snapshot currency.
- AC-8 `parseYahooSearch(body, { international: true })` keeps dotted equity symbols (BBCA.JK); the US-only default is unchanged.
- AC-9 Live: `/api/quant/BBCA.JK` returns name "PT Bank Central Asia Tbk", currency IDR, benchmark ^JKSE and a PragValue (or a stated reason); finder `q=BBCA` lists BBCA.JK.
- AC-10 `readStoredFile(path)` reads `path`, else `path.gz` gunzipped; `compressStoredFile` writes `.gz` and removes the original only after a verified round trip.
- AC-11 storage-gc treats `x.gz` as referenced when a row names `x`.
- AC-12 `pruneQuantSnapshots` keeps only each ticker's newest row.
- AC-13 `rescaleDcf(dcf, growth, price)` with the model's own growth reproduces the model's intrinsic values (±0.01); higher growth gives a higher value.
- AC-14 Watchlist API: add (idempotent per ticker), list newest first, remove; ticker validated by TICKER_PATTERN.
- AC-15 Star toggles on Quant rail and Research asset header; watchlist visible on Home and `/quant`.
- AC-16 `model-settings` accepts only whitelisted keys; API keys are write-only (GET returns `set`/last 4 only); file written atomically to `.env.settings.local`.
- AC-17 Worker applies settings before each job: set keys override, removed keys restore the original value.
- AC-18 No bare "Loading…" text remains in pages; all use the shared loading component.
- AC-19 Quant ticker page has a combobox search reusing the finder's search.
- AC-20 PragValue and PragTrend have multi-part explanations (what, how, how to read) on the finder and the ticker page.

## Tests

- `acceptance/` — the tests the implementation runs (copied into `tests/` as `quant-intl-watchlist.test.ts`).
- `verification/` — live checks (curl scenarios) run at the end.

## Design choices (workshop `prototype/workshop/quant-intl-round/index.html`, picked by the user 2026-11-28)

L1 skeleton + step card · S1 search in the tab bar · G1 growth sliders drawer · W1 watchlist cards on Home and the Quant finder · T1 settings as Providers + Models cards · D1 What / How / How to read explainers.

## Test changes after the freeze

| Test | Change | Reason (contract) |
| --- | --- | --- |
| `acceptance/quant-intl-watchlist.test.ts` (this folder's copy) | Imports `../src/` → `../../../src/` | The copy sits three levels deep; `tests/` keeps `../src/`. Assertions unchanged. |
| `verification/live-checks.sh` | `Origin: $BASE` header on the watchlist POST and DELETE | The app's CSRF guard (`src/proxy.ts`) refuses cross-site writes; without it AC-14 failed on a 403, not on the feature. Assertions unchanged. |
| `tests/quant-finder.test.ts` | Expected `FinderSnapshot` includes `currency: null` | AC-7: snapshots carry the listing currency. |
| `Implementations/quant-page/acceptance/p4e-loader.test.ts` | Non-filer case stubs Yahoo search/timeseries (empty) and expects "Yahoo Finance has no annual statements for this listing." | P3: non-SEC listings now try Yahoo statements. |
| `…/quant-page/acceptance/p5b-page-review.test.tsx` | Loading announced by `role="status"` or `<PageLoading` | P8: the role lives in the shared loading component. |
| `…/quant-page/acceptance/p4c-review2.test.tsx`, `p5-page.test.tsx` | "PQ-Grade" → "PQ Grade" (header `</h2>`); finder validation read from `quant-search.tsx` | P2 (user item 6) and P9 (search extracted). |

## Completion evidence

- Acceptance: `npx tsx --test tests/quant-intl-watchlist.test.ts` → 9/9 pass (baseline: module-not-found failure).
- Verification: `BASE=http://127.0.0.1:3000 bash verification/live-checks.sh` → 10/10 PASS.
- `npx tsc --noEmit` clean; `npm run lint` 0 errors; `npm run test:unit` 913 pass, 0 fail; `python tools/docs_sync.py check` in sync.
- Apple (item 10): seeded Apple has slug `apple`, listing AAPL; `POST /api/assets` slug `btc` (equity) → 409 `DUPLICATE_LISTING` with `existing_id`; `GET /api/assets` returns `symbols`; profile resolution against the dev DB: equity → `operating_company`, Financial Services → `financials`, fund → `etf_fund`.
- BBCA.JK (item 7) before: name "BBCA.JK", no PragValue, `$6000.00`, RS vs S&P 500, finder "BBCA" → nothing. After: "PT Bank Central Asia Tbk", IDR, ^JKSE (Jakarta Composite), engine C, PQ A-, intrinsic Rp6,075 / 7,993 / 9,015; finder "BBCA" lists BBCA.JK first. AAPL unchanged path (SEC companyfacts, ^GSPC, XLK).
- Storage (item 1) dry runs: GC 684 entries / 431 MB reclaimable; compaction 355 files / 614 MB before gzip; `.next` 1.9 GB (cache 596 MB, dev 1.3 GB). Nothing deleted or compacted without the user's yes.
- Review panel round 1 (Opus 5.5, medium effort; R1 9/10, R2 7.5/10, R3 8/10). Fixed:
  - R2: a profile-less run now gets a profile at run creation, and `asset_identity` also writes it to the run row (later stages reload it); London `GBp`, Johannesburg `ZAc` and Tel Aviv `ILA` quotes convert to the major unit (TSCO.L 549.6p → £5.50, PQ A-); `rescaleDcf` uses the DCF's unrounded growth and discount (BBCA.JK reproduces 6074.78 / 7992.86 / 9015.23 exactly). New tests: `tests/quant-intl-review-fixes.test.ts`.
  - R1: `clean:next` is now a dry run unless `--apply`, matching AGENTS.md.
  - R3: `docs/architecture.md` coverage rows for Watchlist, Model settings and `./storage`; the Settings page in `docs/local-agent-harness.md` and `docs/local-development.md`.
  - Also: finder and watchlist sparklines label prices in the listing currency; the unused `storedFileExists` was removed (it caused a new build tracing warning).
- `npm run build` exit 0; the production build served on :3006 passes all 10 live checks and serves AAPL (USD, ^GSPC), TSCO.L (GBP, ^FTSE) and BBCA.JK (IDR, ^JKSE).
- Review panel round 2: R1 10/10, R2 10/10, R3 10/10 on the same working tree.
- Database suites on the separate `research_os_panel_test` database: `npm run test:sofi-v3` pass. `npm run test:db` 1656 pass, 9 fail. Two failures were this branch's and are fixed (the watchlist star used the amber as text colour; the "PQ Grade" header was uppercase and letter-spaced). The other 7 already fail on `a72856d`: `new.module.css` hex and uppercase, the older ui-remaster token tests that ban `--font-display`, the run-flow AC-9 source match from PR 161, and `storage-gc.test.ts` comparing posix paths on Windows.
- Browser checks: ticker page (Rp prices, PQ Grade header, star, tab-bar search, About link, growth drawer moving base +8.7% → +20% gives +61.0%), finder, Home watchlist card, Settings page, research header star.

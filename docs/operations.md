# Operations

Procedures that aren't covered in [local-development.md](local-development.md). Each one changes stored data, so run it only when the user asks.

## Storage cleanup

Nothing deletes files under `storage/` during normal work. Over time three kinds of entry pile up:

- Files and folders that no database row names anymore. Test and scratch databases get dropped, but the files their runs wrote stay behind. Exports and backtests also leave folders this way.
- Copies of SEC filings stored before `storedSecFiling` reused Archives documents (audit RMEM3). SEC appends a random `<script>` tag before `</body>` on every response, so each run stored another full copy. Older copies have no tag at all.
- `storage/parses/*.txt`: a normalized-text copy of each research-memory parse. Nothing ever read these files, and new parses no longer write them (audit M5).

`scripts/storage-gc.ts` finds all three. It changes nothing unless you pass `--apply`.

```bash
npx tsx scripts/storage-gc.ts                      # dry run: counts, bytes, 5 sample paths per category
npx tsx scripts/storage-gc.ts --list               # dry run, every path and every skipped duplicate
npx tsx scripts/storage-gc.ts --parse-texts        # also plan clearing the write-only parse texts
npx tsx scripts/storage-gc.ts --apply              # act on the plan
```

| Option | Default | Effect |
| --- | --- | --- |
| `--storage <dir>` | `./storage` | Storage folder to scan. Relative row paths (`storage/...`) resolve against its parent folder. |
| `--min-age-hours <n>` | `24` | Leaves alone anything that changed more recently than this, even when no row names it. This covers a file written just before its row is committed. |
| `--parse-texts` | off | Clears `document_parses.output_storage_path` for `storage/parses/` paths in every database, then deletes those files. |
| `--list` | off | Prints every candidate path, not just the first 5 per category. |
| `--apply` | off | Repoints duplicates and deletes entries. Without it the script only reads. |

How it decides what to remove:

1. **Databases.** The script reads references from every database on `DATABASE_URL`'s server that has a `source_documents` table: dev, `research_os_test`, worktree and scratch databases. These share `storage/` through symlinks, and `source_documents` dedupes by hash across them. If any database can't be read, the script stops without planning anything.
2. **SEC duplicates.** It groups the filing fetcher's rows (`metadata_json.source = 'sec_edgar_filing'`) by Archives URL. In each group, the oldest row whose file still matches its `file_hash` is the canonical copy. A later row is repointed only when its file equals the canonical file after the bot script is removed. Anything else is reported as left alone. A repointed row keeps its id, `file_hash`, chunks, passages and citations, so `source_locations` stay valid. Only `storage_path` changes, plus its `system-source-payload` parse path. The original path is recorded in `metadata_json.storage_deduplicated`. Since `storage_path` no longer matches `file_hash`, `storedSecFiling` skips that row and reads the canonical row before it.
3. **Unreferenced entries.** These are entries in `storage/sources`, `storage/parses` and `storage/exports` that no row names in any database. Rows can name them through `source_documents.storage_path`, `document_parses.output_storage_path`, `exports`, `backtest_artifacts`, `valuation_artifacts` or a `synthetic_report` artifact's `storagePath`. A folder counts as named when it holds a named path. For `storage/backtests/<run_id>`, the test is whether any database still has that run. `storage/evaluations` is never touched.
4. **Apply.** The script refuses to run while a research worker is sending heartbeats to any of the databases. A dry run checks too and prints a warning naming each live worker and its database, since `--apply` would refuse. Planning can take a while, so apply checks the heartbeats again before repointing and again right before deleting, and stops if a worker has started. It repoints the duplicates (one transaction per database), clears parse-text paths if `--parse-texts` was given, and reads every database again. Then it deletes only the planned entries that are still unreferenced and still older than `--min-age-hours`; an entry changed since planning is kept.

Before `--apply`:

- Run the dry run and check the counts.
- Stop the research workers and dev servers that use these databases.
- Back up the dev database (`pg_dump`) and `storage/`. Deleted files can't be recovered.

Dry run on 2026-10-14, main checkout `storage/`, 10 databases:

| Category | Entries | Size |
| --- | --- | --- |
| SEC duplicate rows to repoint | 151 in `research_os`, 151 in `rr_paidcheck` (a restored copy) | |
| Their redundant files | 151 | 355 MB |
| `storage/sources`, all unreferenced (includes the 151) | 829 | 532 MB |
| `storage/parses` | 158 | 0.2 MB |
| `storage/parses` with `--parse-texts` | 356 | 88 MB |
| `storage/exports` | 74 | 2.9 MB |
| `storage/backtests` | 113 | 41 MB |
| Total | 1,174 | 577 MB |
| Total with `--parse-texts` | 1,372 | 665 MB |

The duplicate rows' raw chunks and passages (about 62,000 `document_chunks` rows in the audit) stay. Citations point at them, so deleting them would break evidence locations.

The database also has three tables that no schema file or migration defines: `agent_sessions` (2 MB), `agent_session_messages` (10 MB, last written 2026-09-01) and `model_budget_reservations` (0.3 MB). The script leaves them alone. Dropping them needs a decision and a Drizzle migration.

## Sync research between machines

Each machine runs its own local Postgres and `storage/`. Research moves between machines through the `research-store` branch of this repository, never through a shared database. `scripts/research-store.ts` (logic in `src/lib/maintenance/research-store.ts`) checks the branch out into the gitignored `./research-store/` folder and keeps it apart from `main`, so syncing never needs a pull request.

```bash
npm run store:sync      # fetch the branch, import it, export this database over it, commit and push
npm run store:import    # import the checked-out store only
npm run store:export    # export to the store folder only; no git
```

`store:sync -- --no-push` commits without pushing. `--store <dir>` uses another folder.

What one sync does:

1. Refuses to start while a research worker is polling this database (a heartbeat in the last 30 s). Stop the worker first.
2. Adds the worktree on first use: it checks out `origin/research-store` if it exists, or creates the branch.
3. Resets the folder to `origin/research-store`. The store is derived from the database, so an unpushed local commit is safe to drop: the export in step 5 writes those rows again.
4. Imports the store in one transaction, in foreign-key order, reading it a line at a time and inserting in batches (a row that points at another row of its table goes in after it). A failure changes nothing. Each row is merged three ways against this machine's last export, kept in `storage/.research-store-base.<database>.json`:
   - changed only in the store: the store's row is taken;
   - changed only here: this machine's row is kept;
   - changed on both machines: the newer `updated_at` wins, and a table without `updated_at` keeps this machine's row. Each such row is printed;
   - deleted here and unchanged in the store: it stays deleted.
   A store row whose unique key (an asset slug, a file hash, a seeded definition) matches a different local row is treated as that row, and its id is rewritten to the local id wherever it appears. Files the store has and this machine lacks are copied into `storage/`. A file that differs is kept as it is here and reported. Import skips and reports any store file outside `files/storage/<dir>/`, any symlink, and any file whose target folder resolves outside `storage/<dir>`.
5. Exports every table except `research_run_jobs` and `research_worker_heartbeats` to `tables/<table>/<first two id characters>.jsonl` (256 shards per table), one `to_jsonb` row per line, sorted by id. Rows stream through a cursor, so only one shard is in memory at a time. If a shard would pass 95 MB, export stops with an error before writing it, rather than letting GitHub reject the push. It mirrors every `storage/...` path a row names into `files/`. It copies only regular files whose real path stays inside their `storage/<dir>`, skips and reports symlinks and files over 95 MB (GitHub's limit), and writes `manifest.json` with each table's columns.
6. Commits and pushes if anything changed.

Import refuses a store whose tables or columns differ from this database. Run `npm run db:migrate` on both machines, on the same code, before syncing.

Rules and limits:

- Imported runs never start on their own, because the job queue isn't synced. Resume one from the UI on the machine that should run it.
- Work on a given run on one machine at a time. When both machines change the same row, one version wins and the other is lost.
- Deletions don't propagate. A row deleted on one machine comes back from the other machine's next export.
- Two machines syncing at the same moment race on the push. The second push fails; run `store:sync` again.
- Stores written before the switch to two-character shards still import. The first export after the switch rewrites every table file once, so that sync pushes a large commit.
- A shard refused for size needs finer sharding (`shardOf` in `src/lib/maintenance/research-store.ts`) before sync works again. A failed export leaves the store folder half-written; the next sync resets it to the branch.

To set up a new machine: install Postgres, create an empty database, point `DATABASE_URL` at it, run `npm run db:migrate`, then `npm run store:sync`. Skip `npm run db:seed`, since the store already holds the seeded rows.

## Monitoring check

`npm run monitor:check` checks whether an asset's research is out of date. It is free: it makes no model call, and it never queues or starts a run. It reads EDGAR and writes one row per asset to `asset_monitor_checks`. The asset page shows the latest row.

```bash
npm run monitor:check                          # every asset with a completed run
npm run monitor:check -- meta-platforms sofi   # only these asset slugs
```

For each asset's latest `completed` pipeline-v3 run, it:

1. Takes the SEC CIK from the run's stored EDGAR filing URLs, or looks up the listing symbol in SEC's ticker map.
2. Reads `https://data.sec.gov/submissions/CIK<cik>.json` and lists the 10-Q and 10-K filings filed after the run's source cutoff. Only `data.sec.gov` and `www.sec.gov` are fetched, over HTTPS and without redirects.
3. Parses the newest four with the deterministic filing parser, reusing a stored copy of the filing when one exists.
4. Scores the run's monitoring dashboard on the new quarter. An item with no reading in the new filings is `not_checkable`.
5. Stores the result: `refresh_due` or `current`, `skipped` (no CIK) or `failed` (the error is kept in the reasons). One asset's failure doesn't stop the others.

A refresh is due when a new 10-Q or 10-K exists, a KPI is past its danger line, or the run's `refresh_schedule.next_refresh_at` has passed. To act on it, start a new run of the asset from the UI or with `POST /api/assets/<id>/research-runs`. The new run links to the last completed run by default, and queuing it is a separate, explicit step. To schedule the check, run the command from cron or launchd. It needs only `DATABASE_URL`, which it reads from `.env.local` when the variable isn't set. Rows accumulate, and nothing prunes them. They are deleted with their asset.

Recovery: a `failed` row usually means the SEC was unreachable or rate-limited it. Run the command again later. SEC asks for a descriptive User-Agent, and the script sends the same placeholder as the pipeline (AR-SEC-6).

## Company profiles (logos and leadership)

Pages show each company's logo and its founders and executives from Wikidata and Wikipedia ([system](system.md#interface-design-system-key-numbers-and-company-profiles)). The first view of a company starts the lookup, and later views read the `company_profiles` table (migration `0024`).

- **Throughput.** Wikimedia's API limits (2026) allow 10 requests a minute for a User-Agent with no contact details and 200 with one. Lookups run one request at a time.
  - Without `WIKIMEDIA_CONTACT`, requests are spaced 6.5 s apart (about 9 a minute). A new company needs about 4 requests, so its logo and leadership take about 30 seconds and appear when the lookup finishes.
  - With `WIKIMEDIA_CONTACT` set, the spacing is 0.4 s and a new company takes 2 to 3 seconds.
- **Speeding lookups up.** Add `WIKIMEDIA_CONTACT=<value>` to `.env.local` and restart the app server (`npm run dev` or `npm start`). The research worker does no lookups.
  - The value is a URL or email address that you, the operator, choose, for example a project page or a role mailbox. It goes into the User-Agent, as Wikimedia's policy asks.
  - Leave it unset if you don't want to send any contact detail. Lookups still work, only slower.
  - The value is sanitised (only letters, digits and `@ . : / + ~ - _` are kept, 120 characters at most). A value with no usable characters counts as unset.
- **How to tell.**
  - The first time lookups run unidentified, the server logs one line, once per process: `[company-profiles] Wikimedia lookups are unidentified: WIKIMEDIA_CONTACT is not set …`. It names the setting and this section, never a value.
  - While a company is still pending and lookups are unidentified, `POST /api/company-profiles` answers `throttled: true`. The page then shows a quiet note under the leadership placeholder ("Still looking up this company…"), and the same text as the logo monogram's tooltip.
  - After you set `WIKIMEDIA_CONTACT` and restart, neither the line nor the note appears.
- **Switching off.** Set `COMPANY_PROFILES=off` to stop all lookups. Pages then show cached logos, monograms and initials.
- **Refreshing.** Rows refresh on their own after their TTL: 30 days when resolved, 7 days when not found, 1 hour when failed. To force a refresh, delete the row: `DELETE FROM company_profiles WHERE key = 'ticker:SOFI';`.
- **Rate limited.** A 429 from Wikimedia pauses all lookups for its Retry-After, at least 60 seconds. Nothing is cached for it, and the next view tries again.

## XBRL warehouse

The warehouse in `services/xbrl/` is optional. Without `XBRL_WAREHOUSE_URL`, runs use SEC companyfacts. Its own procedures are the source of truth: `services/xbrl/AGENTS.md` ("Run locally") and `services/xbrl/sec-xbrl-warehouse/docs/OPERATIONS.md`. Check `services/xbrl/sec-xbrl-warehouse/HANDOFF.md` before starting a worker or enqueueing jobs.

1. **Start it.** From the repository root, `npm run xbrl:compose -- <args>` runs `docker compose` on the warehouse's compose file and project directory, for example:
   - `npm run xbrl:compose -- up -d postgres clickhouse minio minio-init`
   - then `npm run xbrl:compose -- up -d api`.
   - Copy `.env.example` to `.env` in `services/xbrl/sec-xbrl-warehouse/` only on a fresh install, and set a real `XBRL_SEC_USER_AGENT`.
   - Host ports differ from the pipeline's. The warehouse publishes Postgres on 127.0.0.1:5434 (the pipeline uses 5432, the test database 5433) and Grafana on 3001 (Next dev uses 3000).
     - A `.env` carried over from the old XBRL-Parser checkout may still say `POSTGRES_PORT=5432` or `GRAFANA_PORT=3000`; change both values.
     - Don't export `POSTGRES_PASSWORD`, `POSTGRES_USER` or `POSTGRES_DB` in your shell. Both compose files read those names, and a shell value overrides each stack's own setting.
   - Never run `down -v`: it deletes the data volumes.
2. **Load an issuer.** The pipeline never writes to the warehouse.
   - Queue one company with `npm run xbrl:compose -- run --rm admin filing discover --cik <CIK>`.
   - Then run one SEC fetch worker (`worker run --job-type fetch_filing`) and parse workers, as its guide describes.
   - Run the SEC fetch worker when no research run is collecting sources. The warehouse's SEC lock covers its own processes only.
3. **Point runs at it.** Set `XBRL_WAREHOUSE_URL=http://127.0.0.1:8080` in `.env.local` and restart the worker.
   - A run then reads the warehouse when it holds the issuer's newest periodic filing by the cutoff.
   - Check which source a run used in its primary source context: `companyFactsOrigin.provider`, and `reason` when it fell back to SEC.
4. **Turn it off.** Unset `XBRL_WAREHOUSE_URL`. Stored runs keep the companyfacts they were built from.

## Quant page

- **Setup.** The page needs the `quant_snapshots` table: run `npm run db:migrate` after pulling (migration `0025_quant_snapshots`, additive).
- **First look-up.** Opening `/quant/<TICKER>` the first time fetches SEC submissions and companyfacts (or warehouse facts) and syncs about six years of daily prices for the ticker, the S&P 500 and its sector ETF. That takes a few seconds; later views that day come from the cache.
- **Refresh.** The page's Refresh button (`?refresh=1`) recomputes and replaces the day's snapshot.
- **Clean up.** Reference assets created for look-ups are named `quant-<ticker>` and `benchmark-<etf>`. To drop cached snapshots: `DELETE FROM quant_snapshots;`. Removing reference assets and their bars follows the storage-cleanup procedure.

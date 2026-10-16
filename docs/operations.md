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
4. Imports the store in one transaction, in foreign-key order. A failure changes nothing. Each row is merged three ways against this machine's last export, kept in `storage/.research-store-base.<database>.json`:
   - changed only in the store: the store's row is taken;
   - changed only here: this machine's row is kept;
   - changed on both machines: the newer `updated_at` wins, and a table without `updated_at` keeps this machine's row. Each such row is printed;
   - deleted here and unchanged in the store: it stays deleted.
   A store row whose unique key (an asset slug, a file hash, a seeded definition) matches a different local row is treated as that row, and its id is rewritten to the local id wherever it appears. Files the store has and this machine lacks are copied into `storage/`. A file that differs is kept as it is here and reported.
5. Exports every table except `research_run_jobs` and `research_worker_heartbeats` to `tables/<table>/<first id character>.jsonl`, one `to_jsonb` row per line, sorted by id. It mirrors every `storage/...` path a row names into `files/`, skipping files over 95 MB (GitHub's limit), and writes `manifest.json` with each table's columns.
6. Commits and pushes if anything changed.

Import refuses a store whose tables or columns differ from this database. Run `npm run db:migrate` on both machines, on the same code, before syncing.

Rules and limits:

- Imported runs never start on their own, because the job queue isn't synced. Resume one from the UI on the machine that should run it.
- Work on a given run on one machine at a time. When both machines change the same row, one version wins and the other is lost.
- Deletions don't propagate. A row deleted on one machine comes back from the other machine's next export.
- Two machines syncing at the same moment race on the push. The second push fails; run `store:sync` again.

To set up a new machine: install Postgres, create an empty database, point `DATABASE_URL` at it, run `npm run db:migrate`, then `npm run store:sync`. Skip `npm run db:seed`, since the store already holds the seeded rows.

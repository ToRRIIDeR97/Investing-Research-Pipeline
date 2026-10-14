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
4. **Apply.** The script refuses to run while a research worker is sending heartbeats to any of the databases. It repoints the duplicates (one transaction per database), clears parse-text paths if `--parse-texts` was given, and reads every database again. Then it deletes only the planned entries that are still unreferenced.

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

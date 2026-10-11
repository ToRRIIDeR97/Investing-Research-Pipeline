// Runs every test file one at a time against the database. The suites share one database, so
// running them in parallel lets their runs, jobs and cleanup interfere with each other.
// Only DATABASE_URL is taken from .env.local: provider and retry settings there would change
// test behaviour, and tests must never reach a paid provider.
// The suites refuse a database a research worker is polling: the worker would claim test jobs
// and run them on its own provider, and the tests' cleanup would delete its runs.
const { spawnSync } = require('child_process');
const { existsSync, readFileSync } = require('fs');
const postgres = require('postgres');

async function liveWorkers(url) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql`SELECT worker_id FROM research_worker_heartbeats
      WHERE status = 'healthy' AND last_seen_at > NOW() - INTERVAL '30 seconds'`;
    return rows.map(row => row.worker_id);
  } catch (error) {
    if (error.code === '42P01') return []; // Not migrated yet: no worker can be using it.
    throw error;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  const env = { ...process.env, RUN_DB_INTEGRATION: '1', RESEARCH_MODEL_PROVIDER: 'mock', RESEARCH_ACCEPTANCE_PROVIDER: 'mock' };
  if (!env.DATABASE_URL && existsSync('.env.local')) {
    const line = readFileSync('.env.local', 'utf8').split(/\r?\n/).find(l => /^DATABASE_URL=/.test(l.trim()));
    if (line) env.DATABASE_URL = line.trim().slice('DATABASE_URL='.length).replace(/^['"]|['"]$/g, '');
  }
  if (!env.DATABASE_URL) {
    console.error('Set DATABASE_URL or add it to .env.local');
    process.exit(1);
  }
  const workers = await liveWorkers(env.DATABASE_URL);
  if (workers.length) {
    console.error(`Refusing to run: research worker ${workers.join(', ')} sent a heartbeat to this database in the last 30 s. ` +
      'Point DATABASE_URL at a separate test database, or stop the worker.');
    process.exit(1);
  }
  const files = process.argv.slice(2).length ? process.argv.slice(2)
    : ['tests/*.test.ts', 'Implementations/*/acceptance/*.test.ts', 'Implementations/*/verification/*.test.ts'];
  const result = spawnSync('npx', ['tsx', '--test', '--test-concurrency=1', ...files], { stdio: 'inherit', env, shell: true });
  process.exit(result.status ?? 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

// Runs every test file one at a time against the database. The suites share one database, so
// running them in parallel lets their runs, jobs and cleanup interfere with each other.
// Only DATABASE_URL is taken from .env.local: provider and retry settings there would change
// test behaviour, and tests must never reach a paid provider.
const { spawnSync } = require('child_process');
const { existsSync, readFileSync } = require('fs');

const env = { ...process.env, RUN_DB_INTEGRATION: '1', RESEARCH_MODEL_PROVIDER: 'mock', RESEARCH_ACCEPTANCE_PROVIDER: 'mock' };
if (!env.DATABASE_URL && existsSync('.env.local')) {
  const line = readFileSync('.env.local', 'utf8').split(/\r?\n/).find(l => /^DATABASE_URL=/.test(l.trim()));
  if (line) env.DATABASE_URL = line.trim().slice('DATABASE_URL='.length).replace(/^['"]|['"]$/g, '');
}
if (!env.DATABASE_URL) {
  console.error('Set DATABASE_URL or add it to .env.local');
  process.exit(1);
}
const files = process.argv.slice(2).length ? process.argv.slice(2)
  : ['tests/*.test.ts', 'Implementations/*/acceptance/*.test.ts', 'Implementations/*/verification/*.test.ts'];
const result = spawnSync('npx', ['tsx', '--test', '--test-concurrency=1', ...files], { stdio: 'inherit', env, shell: true });
process.exit(result.status ?? 1);

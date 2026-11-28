// Starts the research worker with DATABASE_URL derived from WINDOWS_DATABASE_ADMIN_URL in .env (research_os database),
// as scripts/dev-with-db.cjs does for the dev server. An existing DATABASE_URL wins. Extra arguments (e.g. --once) pass
// through. The password stays out of the command line.
const { existsSync, readFileSync } = require('fs');
const { spawn } = require('child_process');

if (!process.env.DATABASE_URL) {
  let admin = process.env.WINDOWS_DATABASE_ADMIN_URL;
  if (!admin && existsSync('.env')) {
    const line = readFileSync('.env', 'utf8').split(/\r?\n/).find((l) => /^WINDOWS_DATABASE_ADMIN_URL=/.test(l.trim()));
    if (line) admin = line.trim().slice('WINDOWS_DATABASE_ADMIN_URL='.length).replace(/^['"]|['"]$/g, '');
  }
  if (!admin) {
    console.error('Set DATABASE_URL, or WINDOWS_DATABASE_ADMIN_URL in .env');
    process.exit(1);
  }
  const url = new URL(admin);
  url.pathname = '/research_os';
  process.env.DATABASE_URL = url.toString();
}

const child = spawn('npx', ['tsx', 'src/workers/research-worker.ts', ...process.argv.slice(2)], { stdio: 'inherit', shell: true, env: process.env });
child.on('exit', (code) => process.exit(code ?? 0));

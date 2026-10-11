// Starts `next dev` with DATABASE_URL derived from WINDOWS_DATABASE_ADMIN_URL (research_os database).
const { spawn } = require('child_process');
if (!process.env.DATABASE_URL && process.env.WINDOWS_DATABASE_ADMIN_URL) {
  const url = new URL(process.env.WINDOWS_DATABASE_ADMIN_URL);
  url.pathname = '/research_os';
  process.env.DATABASE_URL = url.toString();
}
const child = spawn('npx', ['next', 'dev', '-H', '127.0.0.1', '-p', '3000'], { stdio: 'inherit', shell: true, env: process.env });
child.on('exit', code => process.exit(code ?? 0));

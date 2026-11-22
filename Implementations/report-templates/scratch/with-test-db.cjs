// Runs a command with DATABASE_URL pointed at the local test database research_os_arch_test on this Windows checkout.
// The URL is built from WINDOWS_DATABASE_ADMIN_URL in the repository's .env and is never printed.
// Usage (from the repository root): node Implementations/report-templates/scratch/with-test-db.cjs npm run test:sofi-v3
const { readFileSync, existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = process.env.REPORT_TEMPLATES_ENV_ROOT || "C:/Users/sense/OneDrive/Documents/GitHub/Investing-Research-Pipeline";
const envFile = path.join(root, ".env");
if (!existsSync(envFile)) { console.error(`No .env at ${envFile}`); process.exit(2); }
const line = readFileSync(envFile, "utf8").split(/\r?\n/).find(l => l.startsWith("WINDOWS_DATABASE_ADMIN_URL="));
if (!line) { console.error("WINDOWS_DATABASE_ADMIN_URL is not set in .env"); process.exit(2); }
const url = new URL(line.slice("WINDOWS_DATABASE_ADMIN_URL=".length).trim().replace(/^['"]|['"]$/g, ""));
url.pathname = "/" + (process.env.REPORT_TEMPLATES_TEST_DB || "research_os_arch_test");
const [cmd, ...args] = process.argv.slice(2);
if (!cmd) { console.error("Give a command to run"); process.exit(2); }
const result = spawnSync(cmd, args, { stdio: "inherit", shell: true, env: { ...process.env, DATABASE_URL: url.toString() } });
process.exit(result.status ?? 1);

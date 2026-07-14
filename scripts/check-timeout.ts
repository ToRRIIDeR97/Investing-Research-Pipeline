import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

function loadEnvFile(fileName: string) {
  const path = resolve(process.cwd(), fileName);
  if (!existsSync(path)) return;

  const contents = readFileSync(path, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (process.env[key]) continue;
    const rawValue = valueParts.join("=").trim();
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env");

// We can extract agentTimeoutMs function or test it
const agentName = "asset-analyst";
const specific = process.env[`OPENCODE_${agentName.toUpperCase().replace(/-/g, "_")}_TIMEOUT_MS`];
const configured = Number(specific || process.env.OPENCODE_AGENT_TIMEOUT_MS || 240000);
const timeoutMs = Number.isFinite(configured) && configured >= 10000 ? configured : 240000;

console.log("OPENCODE_ASSET_ANALYST_TIMEOUT_MS env:", specific);
console.log("OPENCODE_AGENT_TIMEOUT_MS env:", process.env.OPENCODE_AGENT_TIMEOUT_MS);
console.log("Configured value:", configured);
console.log("Final timeoutMs:", timeoutMs);

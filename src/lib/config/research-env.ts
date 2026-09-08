import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function isModelRoutingKey(key: string) {
  return key.startsWith("RESEARCH_") && key.endsWith("_MODEL");
}

export function loadResearchEnvFiles(cwd = process.cwd(), fileNames = [".env.local", ".env"]) {
  const paths = fileNames.map((fileName) => resolve(cwd, fileName)).filter(existsSync);
  if (!paths.length) return;

  for (const key of Object.keys(process.env)) {
    if (isModelRoutingKey(key)) delete process.env[key];
  }

  const loaded = new Set<string>();
  for (const path of paths) {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [key, ...valueParts] = trimmed.split("=");
      if (loaded.has(key) || (process.env[key] && !isModelRoutingKey(key))) continue;
      process.env[key] = valueParts.join("=").trim().replace(/^['"]|['"]$/g, "");
      loaded.add(key);
    }
  }
}

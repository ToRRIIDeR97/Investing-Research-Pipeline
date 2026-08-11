import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { ProviderError } from "./errors";

export interface SkillDefinition {
  name: string;
  description: string;
  path: string;
  directory: string;
  content: string;
  files: string[];
}

function parseFrontmatter(content: string, path: string) {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/.exec(content);
  if (!match) throw new ProviderError(`Skill is missing frontmatter: ${path}`, "invalid_request");
  const values: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(values.name || "")) {
    throw new ProviderError(`Skill has an invalid name: ${path}`, "invalid_request");
  }
  return { name: values.name, description: values.description || "", body: content.slice(match[0].length) };
}

function inside(root: string, candidate: string) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function skillFiles(directory: string, root: string, maxFiles: number) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (files.length >= maxFiles) break;
    if (!entry.isFile() || entry.name === "SKILL.md") continue;
    const path = resolve(directory, entry.name);
    const resolved = await realpath(path);
    if (!inside(root, resolved)) throw new ProviderError(`Skill file escapes configured root: ${path}`, "invalid_request");
    files.push(resolved);
  }
  return files;
}

async function scan(root: string, maxSkills: number) {
  const found: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8 || found.length >= maxSkills) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (found.length >= maxSkills) break;
      const path = resolve(directory, entry.name);
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.isFile() && entry.name === "SKILL.md") found.push(path);
    }
  };
  await visit(root, 0);
  return found;
}

export async function discoverSkills(options: {
  roots: string[];
  maxSkills?: number;
  maxBytes?: number;
  maxFilesPerSkill?: number;
}): Promise<SkillDefinition[]> {
  const maxSkills = options.maxSkills || 100;
  const maxBytes = options.maxBytes || 64 * 1024;
  const maxFiles = options.maxFilesPerSkill || 10;
  const skills = new Map<string, SkillDefinition>();

  for (const configuredRoot of options.roots) {
    if (skills.size >= maxSkills) break;
    const root = await realpath(resolve(configuredRoot)).catch(() => null);
    if (!root) continue;
    for (const path of await scan(root, maxSkills - skills.size)) {
      const resolved = await realpath(path);
      if (!inside(root, resolved)) throw new ProviderError(`Skill escapes configured root: ${path}`, "invalid_request");
      const stats = await lstat(resolved);
      if (stats.size > maxBytes) throw new ProviderError(`Skill exceeds ${maxBytes} bytes: ${resolved}`, "response_limit");
      const content = await readFile(resolved, "utf8");
      if (Buffer.byteLength(content, "utf8") > maxBytes) {
        throw new ProviderError(`Skill exceeds ${maxBytes} bytes: ${resolved}`, "response_limit");
      }
      const parsed = parseFrontmatter(content, resolved);
      skills.set(parsed.name, {
        name: parsed.name,
        description: parsed.description,
        path: resolved,
        directory: dirname(resolved),
        content: parsed.body,
        files: await skillFiles(dirname(resolved), root, maxFiles),
      });
    }
  }
  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function selectSkills(skills: SkillDefinition[], names: string[]) {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  return names.map((name) => {
    const skill = byName.get(name);
    if (!skill) throw new ProviderError(`Requested skill is not available: ${name}`, "permission_denied");
    return skill;
  });
}

export function renderSkillContext(skills: SkillDefinition[]) {
  if (!skills.length) return "";
  return skills.map((skill) => [
    `<skill name="${skill.name}" source="${basename(skill.directory)}">`,
    skill.content,
    "</skill>",
  ].join("\n")).join("\n\n");
}

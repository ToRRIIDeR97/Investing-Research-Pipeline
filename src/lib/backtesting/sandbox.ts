import { execFile } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

/** What the sandboxed child may touch. Paths are absolute. */
export interface SandboxPolicy {
  /** The only directory the child may write to. */
  writeDir: string;
  /** Directories the child must not read (the developer's home and the repository). */
  hiddenDirs: string[];
  /** Directories inside `hiddenDirs` the child still needs to read (runner, Python packages). */
  readDirs: string[];
}

export interface SandboxOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** Resolves an executable to its path, or null. Injected by tests. */
  which?: (name: string) => string | null;
}

export const SANDBOX_OPT_OUT = "BACKTEST_SANDBOX";

function real(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function inside(directory: string, path: string) {
  const rel = relative(directory, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function whichOnPath(name: string, env: Record<string, string | undefined> = process.env) {
  if (isAbsolute(name)) {
    try { accessSync(name, constants.X_OK); return name; } catch { return null; }
  }
  for (const dir of (env.PATH || "").split(delimiter).filter(Boolean)) {
    try { accessSync(join(dir, name), constants.X_OK); return join(dir, name); } catch { /* next */ }
  }
  return null;
}

const sbString = (path: string) => JSON.stringify(real(path));

/**
 * macOS Seatbelt profile. Later rules win, so the denies come first and the narrow allows after.
 * No network, no fork, writes only to `writeDir`, and no reads of the home or repository
 * directories except the runner and Python package paths.
 */
export function macProfile(policy: SandboxPolicy) {
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny process-fork)",
    "(deny file-write*)",
    `(allow file-write* (subpath ${sbString(policy.writeDir)}) (literal "/dev/null"))`,
    ...(policy.hiddenDirs.length ? [`(deny file-read* ${policy.hiddenDirs.map((dir) => `(subpath ${sbString(dir)})`).join(" ")})`] : []),
    `(allow file-read* ${[policy.writeDir, ...policy.readDirs].map((dir) => `(subpath ${sbString(dir)})`).join(" ")})`,
  ].join("\n");
}

/** Linux bubblewrap arguments: read-only root, hidden home and repository, one writable directory, no namespaces shared. */
export function bwrapArgs(policy: SandboxPolicy) {
  return [
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
    ...policy.hiddenDirs.flatMap((dir) => ["--tmpfs", real(dir)]),
    ...policy.readDirs.flatMap((dir) => ["--ro-bind", real(dir), real(dir)]),
    "--bind", real(policy.writeDir), real(policy.writeDir),
    "--unshare-all", "--die-with-parent", "--new-session", "--",
  ];
}

/**
 * Wrap `command args` in the platform's OS sandbox. Fails closed: with no sandbox available it
 * throws, unless BACKTEST_SANDBOX=off is set, which runs the command unsandboxed.
 */
export function sandboxedCommand(command: string, args: string[], policy: SandboxPolicy, options: SandboxOptions = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const which = options.which ?? ((name: string) => whichOnPath(name, env));
  if (env[SANDBOX_OPT_OUT] === "off") return { file: command, args, sandbox: "none" as const };

  if (platform === "darwin") {
    const sandboxExec = which("/usr/bin/sandbox-exec");
    if (sandboxExec) return { file: sandboxExec, args: ["-p", macProfile(policy), command, ...args], sandbox: "sandbox-exec" as const };
  } else if (platform === "linux") {
    const bwrap = which("bwrap");
    if (bwrap) return { file: bwrap, args: [...bwrapArgs(policy), command, ...args], sandbox: "bwrap" as const };
  }
  throw new Error(`No OS sandbox for model-written backtest code on ${platform} (needs sandbox-exec on macOS or bwrap on Linux). ` +
    `Set ${SANDBOX_OPT_OUT}=off to run it unsandboxed.`);
}

const execFileAsync = promisify(execFile);
let pythonPaths: Promise<string[]> | null = null;

/** Directories Python reads at startup and import time (stdlib, site-packages, venv), resolved once per process. */
export function pythonReadPaths(python: string, env: NodeJS.ProcessEnv) {
  pythonPaths ??= execFileAsync(python, ["-c",
    "import json, site, sys; print(json.dumps(sys.path + [sys.prefix, sys.base_prefix, site.getusersitepackages()]))"], { env })
    .then(({ stdout }) => [...new Set((JSON.parse(stdout) as string[]).filter((path) => path && isAbsolute(path)).map(real))])
    .catch((error) => { pythonPaths = null; throw error; });
  return pythonPaths;
}

/** The read allowances a policy needs: only paths strictly inside a hidden directory matter. */
export function readDirsWithin(hiddenDirs: string[], paths: string[]) {
  const hidden = hiddenDirs.map(real);
  return [...new Set(paths.map(real))].filter((path) => hidden.some((dir) => inside(dir, path)));
}

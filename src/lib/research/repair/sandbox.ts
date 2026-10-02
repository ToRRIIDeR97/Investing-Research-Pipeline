import { spawn } from "node:child_process";

export type SandboxResult = { ok: true; output: unknown } | { ok: false; error: string };

// Runs inside the child. The module gets a fresh V8 context with only language builtins;
// its input and output cross the boundary as JSON strings, so no host object is reachable.
const RUNNER = `
const vm = require("node:vm");
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const { source, input, timeoutMs } = JSON.parse(raw);
    const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
    context.__input = JSON.stringify(input);
    vm.runInContext(source, context, { timeout: timeoutMs, filename: "repair-module.js" });
    const output = vm.runInContext(
      'if (typeof locateStatements !== "function") throw new Error("Module must define function locateStatements(filings)");' +
      'const __result = locateStatements(JSON.parse(__input));' +
      'if (__result && typeof __result.then === "function") throw new Error("locateStatements must return synchronously");' +
      'JSON.stringify(__result)', context, { timeout: timeoutMs });
    if (typeof output !== "string") throw new Error("locateStatements must return JSON data");
    process.stdout.write(output);
  } catch (error) {
    process.stderr.write(String(error && error.name ? error.name + ": " + error.message : error));
    process.exitCode = 3;
  }
});`;

/**
 * Execute a generated module in a separate Node process: empty environment, permission model
 * (no file, child-process or worker access) and bounded time, memory and output.
 */
export function runSandboxedModule(source: string, input: unknown,
  options: { timeoutMs?: number; maxOutputBytes?: number; maxMemoryMb?: number } = {}): Promise<SandboxResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["--permission", `--max-old-space-size=${options.maxMemoryMb ?? 96}`, "-e", RUNNER],
      // Deliberately empty: no credentials, database URL or provider settings reach the module.
      { env: {} as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "", settled = false;
    const finish = (result: SandboxResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve(result);
    };
    // The vm timeout covers synchronous loops; this also covers startup and memory exhaustion.
    const timer = setTimeout(() => finish({ ok: false, error: `Module timed out after ${timeoutMs} ms` }), timeoutMs + 2000);
    child.stdout.setEncoding("utf8").on("data", chunk => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > maxOutputBytes) finish({ ok: false, error: `Module output exceeds ${maxOutputBytes} bytes` });
    });
    child.stderr.setEncoding("utf8").on("data", chunk => { if (stderr.length < 4000) stderr += chunk; });
    child.on("error", error => finish({ ok: false, error: `Sandbox failed to start: ${error.message}` }));
    child.on("close", code => {
      if (code !== 0) return finish({ ok: false, error: (stderr.trim() || `Module process exited with code ${code}`).slice(0, 1000) });
      try { finish({ ok: true, output: JSON.parse(stdout) }); }
      catch { finish({ ok: false, error: "Module output is not valid JSON" }); }
    });
    child.stdin.on("error", () => { /* the child may exit before reading all input */ });
    child.stdin.end(JSON.stringify({ source, input, timeoutMs }));
  });
}

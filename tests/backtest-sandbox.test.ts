import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { backtestEnv } from "../src/lib/backtesting/executor";
import { bwrapArgs, macProfile, pythonRuntime, readDirsWithin, sandboxedCommand, type SandboxPolicy } from "../src/lib/backtesting/sandbox";

const policy: SandboxPolicy = { writeDir: "/work/bt", hiddenDirs: ["/home/dev", "/repo"], readDirs: ["/repo/python/backtesting"] };

test("backtest sandbox fails closed without an OS sandbox unless BACKTEST_SANDBOX=off (#11)", () => {
  assert.throws(() => sandboxedCommand("python3", ["x.py"], policy, { platform: "win32", env: {} }), /No OS sandbox/);
  assert.throws(() => sandboxedCommand("python3", ["x.py"], policy, { platform: "linux", env: {}, which: () => null }), /BACKTEST_SANDBOX=off/);
  assert.deepEqual(sandboxedCommand("python3", ["x.py"], policy, { platform: "win32", env: { BACKTEST_SANDBOX: "off" } }),
    { file: "python3", args: ["x.py"], sandbox: "none" });
});

test("backtest sandbox wraps the command in sandbox-exec on macOS and bwrap on Linux", () => {
  const mac = sandboxedCommand("python3", ["x.py"], policy, { platform: "darwin", env: {}, which: (name) => name });
  assert.equal(mac.file, "/usr/bin/sandbox-exec");
  assert.deepEqual(mac.args.slice(-2), ["python3", "x.py"]);
  const profile = macProfile(policy);
  for (const rule of ["(deny network*)", "(deny process-fork)", "(deny mach-lookup)", "(deny appleevent-send)", "(deny system-socket)",
    "(deny file-write*)", '(allow file-write* (subpath "/work/bt")',
    '(deny file-read* (subpath "/home/dev") (subpath "/repo") (subpath "/private/tmp") (subpath "/private/var/tmp") (subpath "/private/var/folders"))', '(allow file-read* (subpath "/work/bt") (subpath "/repo/python/backtesting"))']) {
    assert.ok(profile.includes(rule), rule);
  }

  const linux = sandboxedCommand("python3", ["x.py"], policy, { platform: "linux", env: {}, which: () => "/usr/bin/bwrap" });
  assert.equal(linux.file, "/usr/bin/bwrap");
  const args = bwrapArgs(policy).join(" ");
  assert.match(args, /--unshare-all --die-with-parent --new-session/);
  assert.match(args, /--tmpfs \/tmp --tmpfs \/var\/tmp /);
  // A missing read path must not abort bwrap: --ro-bind-try skips it.
  assert.match(args, /--tmpfs \/home\/dev --tmpfs \/repo --ro-bind-try \/repo\/python\/backtesting \/repo\/python\/backtesting --bind \/work\/bt \/work\/bt/);
  assert.doesNotMatch(args, /--ro-bind \/repo/);
});

test("only existing Python paths inside a hidden directory become read allowances", () => {
  const paths = ["/usr/lib/python3", "/home/dev", "/home/dev/.venv/lib", "/repo", "/repo/.venv/lib", "/home/dev/.local/lib/python3.12/site-packages"];
  const missing = new Set(["/home/dev/.local/lib/python3.12/site-packages"]);
  assert.deepEqual(readDirsWithin(["/home/dev", "/repo"], paths, (path) => !missing.has(path)), ["/home/dev/.venv/lib", "/repo/.venv/lib"]);
});

const noSandboxExec = process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec");

test("sandbox-exec blocks network, fork, Mach lookups, outside writes, and repository and temp reads", { skip: noSandboxExec }, async () => {
  const base = join(process.cwd(), "storage", "tmp-sandbox-test");
  const work = join(base, "work");
  await mkdir(work, { recursive: true });
  const shared = await mkdtemp("/private/tmp/backtest-sandbox-");
  try {
    const planted = join(shared, "other-tool-token.txt");
    await writeFile(planted, "token", "utf8");
    const secret = join(base, "secret.txt");
    await writeFile(secret, "secret", "utf8");
    await writeFile(join(work, "probe.py"), [
      "import ctypes, json, os, socket, sys",
      "lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib')",
      "def lookup(name):",
      "    port = ctypes.c_uint32()",
      "    return lib.bootstrap_look_up(ctypes.c_uint32.in_dll(lib, 'bootstrap_port'), name.encode(), ctypes.byref(port)) == 0",
      "def t(f):",
      "    try:",
      "        f(); return True",
      "    except Exception:",
      "        return False",
      "work = os.path.dirname(os.path.abspath(__file__))",
      "print(json.dumps({",
      "  'read_secret': t(lambda: open(sys.argv[1]).read()),",
      "  'read_env': t(lambda: open(sys.argv[2]).read()),",
      "  'write_work': t(lambda: open(os.path.join(work, 'out.txt'), 'w').write('x')),",
      "  'write_outside': t(lambda: open(sys.argv[1] + '.out', 'w').write('x')),",
      "  'network': t(lambda: socket.create_connection(('1.1.1.1', 443), timeout=3)),",
      "  'fork': t(lambda: os.fork() == 0 and os._exit(0)),",
      "  'list_home': t(lambda: os.listdir(os.path.expanduser('~'))),",
      "  'read_tmp': t(lambda: open(sys.argv[3]).read()),",
      "  'pasteboard': lookup('com.apple.pasteboard.1'),",
      "  'launchservices': lookup('com.apple.coreservices.launchservicesd'),",
      "  'nsurlsessiond': lookup('com.apple.nsurlsessiond'),",
      "}))",
    ].join("\n"), "utf8");
    const { executable } = await pythonRuntime("python3", process.env);
    const { file, args } = sandboxedCommand(executable, ["-B", join(work, "probe.py"), secret, join(process.cwd(), "package.json"), planted],
      { writeDir: work, hiddenDirs: [homedir(), process.cwd()], readDirs: [] }, { env: { PATH: process.env.PATH } });
    const { stdout } = await promisify(execFile)(file, args, { env: backtestEnv() });
    assert.deepEqual(JSON.parse(stdout), {
      read_secret: false, read_env: false, write_work: true, write_outside: false, network: false, fork: false, list_home: false,
      read_tmp: false, pasteboard: false, launchservices: false, nsurlsessiond: false,
    });
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(shared, { recursive: true, force: true });
  }
});

test("run_backtest.py run starts inside sandbox-exec with its cwd outside the repository", { skip: noSandboxExec }, async () => {
  // Stub numpy and pandas, so the test needs no Python packages: read_csv raising proves the runner
  // got past its imports, cwd-free storage-root check and output directory, into reading prices.
  const root = join(process.cwd(), "storage", "tmp-sandbox-runner-test");
  const work = join(root, "run", "bt");
  const stubs = join(work, "stubs");
  await mkdir(stubs, { recursive: true });
  try {
    await writeFile(join(stubs, "numpy.py"), "", "utf8");
    await writeFile(join(stubs, "pandas.py"), "def read_csv(path, **kwargs):\n    raise RuntimeError('stub read_csv ' + str(path))\n", "utf8");
    const config = join(work, "runner-input.json");
    await writeFile(config, JSON.stringify({ symbol: "TEST", start_date: "2024-01-01", strategy_path: join(work, "strategy.py"),
      output_dir: work, storage_root: root }), "utf8");
    const runnerDir = join(process.cwd(), "python", "backtesting");
    const env = { ...backtestEnv(), PYTHONPATH: stubs, TMPDIR: work, PYTHONDONTWRITEBYTECODE: "1" };
    const hiddenDirs = [homedir(), process.cwd()];
    const python = await pythonRuntime("python3", env);
    const { file, args } = sandboxedCommand(python.executable, ["-B", join(runnerDir, "run_backtest.py"), "run", config], {
      writeDir: work, hiddenDirs, readDirs: [runnerDir, ...readDirsWithin(hiddenDirs, python.readPaths)],
    }, { env });
    const error = await promisify(execFile)(file, args, { cwd: work, env }).then(() => null, (failure: { stderr?: string }) => failure);
    assert.ok(error, "the stub read_csv should fail the run");
    assert.match(String(error.stderr), /Backtest failed: stub read_csv .*input\/asset_prices\.csv/);
    assert.doesNotMatch(String(error.stderr), /Operation not permitted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

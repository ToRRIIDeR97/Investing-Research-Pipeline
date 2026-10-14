import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { backtestEnv } from "../src/lib/backtesting/executor";
import { bwrapArgs, macProfile, readDirsWithin, sandboxedCommand, type SandboxPolicy } from "../src/lib/backtesting/sandbox";

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
  for (const rule of ["(deny network*)", "(deny process-fork)", "(deny file-write*)", '(allow file-write* (subpath "/work/bt")',
    '(deny file-read* (subpath "/home/dev") (subpath "/repo"))', '(allow file-read* (subpath "/work/bt") (subpath "/repo/python/backtesting"))']) {
    assert.ok(profile.includes(rule), rule);
  }

  const linux = sandboxedCommand("python3", ["x.py"], policy, { platform: "linux", env: {}, which: () => "/usr/bin/bwrap" });
  assert.equal(linux.file, "/usr/bin/bwrap");
  const args = bwrapArgs(policy).join(" ");
  assert.match(args, /--unshare-all/);
  assert.match(args, /--tmpfs \/home\/dev --tmpfs \/repo --ro-bind \/repo\/python\/backtesting \/repo\/python\/backtesting --bind \/work\/bt \/work\/bt/);
});

test("only Python paths inside a hidden directory become read allowances", () => {
  assert.deepEqual(readDirsWithin(["/home/dev", "/repo"], ["/usr/lib/python3", "/home/dev", "/home/dev/.venv/lib", "/repo", "/repo/.venv/lib"]),
    ["/home/dev/.venv/lib", "/repo/.venv/lib"]);
});

test("sandbox-exec blocks network, fork, outside writes and repository reads", { skip: process.platform !== "darwin" }, async () => {
  const base = join(process.cwd(), "storage", "tmp-sandbox-test");
  const work = join(base, "work");
  await mkdir(work, { recursive: true });
  try {
    const secret = join(base, "secret.txt");
    await writeFile(secret, "secret", "utf8");
    await writeFile(join(work, "probe.py"), [
      "import json, os, socket, sys",
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
      "}))",
    ].join("\n"), "utf8");
    const { file, args } = sandboxedCommand("python3", ["-B", join(work, "probe.py"), secret, join(process.cwd(), "package.json")],
      { writeDir: work, hiddenDirs: [homedir(), process.cwd()], readDirs: [] }, { env: { PATH: process.env.PATH } });
    const { stdout } = await promisify(execFile)(file, args, { env: backtestEnv() });
    assert.deepEqual(JSON.parse(stdout), {
      read_secret: false, read_env: false, write_work: true, write_outside: false, network: false, fork: false, list_home: false,
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

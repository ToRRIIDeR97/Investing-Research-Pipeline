import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Windows creates symlinks only with Developer Mode or admin rights. Tests that build
// symlinks skip with this reason instead of failing on EPERM; elsewhere it is false.
export const symlinkSkip: false | string = (() => {
  const dir = mkdtempSync(join(tmpdir(), "symlink-probe-"));
  try {
    writeFileSync(join(dir, "target"), "");
    symlinkSync(join(dir, "target"), join(dir, "link"));
    return false;
  } catch {
    return "this machine can't create symlinks (on Windows, turn on Developer Mode)";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// Tests that stand in for a binary with a `#!/bin/sh` script on PATH need a POSIX host.
export const posixShellSkip: false | string = process.platform === "win32" ? "needs a POSIX shell to stand in for python3" : false;

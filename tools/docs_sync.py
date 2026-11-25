#!/usr/bin/env python3
"""Keep Markdown docs in sync with the code. Standard library only.

  generate            rewrite the generated blocks in every .md file
  check               fail if a generated block is outdated, or covered code
                      changed since its doc was last stamped
  stamp DOC...|--all  record that DOC was reviewed against the current code
  owners PATH...      list the docs whose `covers` include PATH
  uncovered           list non-Markdown files that no doc covers
  hook                Claude Code Stop hook: generate, then check

A doc declares the code it describes in frontmatter:

    ---
    covers:
      - src/auth/**
    ---

Derived content sits between markers and is rewritten by `generate`:

    <!-- BEGIN GENERATED: tree src 2 -->
    <!-- END GENERATED -->

Generators: tree [PATH] [DEPTH] | docstrings GLOB | scripts [package.json]
            | covers | run NAME   (NAME is a command in docs/generators.json)
"""
import ast
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

LOCK = "docs/docs.lock"
GENERATORS = "docs/generators.json"
SKIP = ("Implementations/",)  # point-in-time task plans, never checked
BEGIN = re.compile(r"<!-- BEGIN GENERATED: (.+?) -->$")
END = "<!-- END GENERATED -->"
ME = "python tools/docs_sync.py"
ROOT = Path(".")


def git(*args):
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True,
                          encoding="utf-8", check=True).stdout


def files():
    """Tracked and untracked-but-not-ignored files that exist, as posix paths."""
    out = git("ls-files", "-co", "--exclude-standard", "-z").split("\0")
    return sorted({f for f in out if f and f != LOCK and (ROOT / f).is_file()})


def read(path):
    return (ROOT / path).read_bytes().decode("utf-8", "replace").replace("\r\n", "\n")


def digest(path):
    data = (ROOT / path).read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(data).hexdigest()[:12]


def glob_re(pattern):
    p = pattern.strip().removeprefix("./")
    if p.endswith("/"):
        p += "**"
    out, i = "", 0
    while i < len(p):
        if p.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif p.startswith("**", i):
            out, i = out + ".*", i + 2
        elif p[i] == "*":
            out, i = out + "[^/]*", i + 1
        elif p[i] == "?":
            out, i = out + "[^/]", i + 1
        else:
            out, i = out + re.escape(p[i]), i + 1
    return re.compile(out + r"\Z")


def covers(text):
    """The `covers` list from a doc's frontmatter (inline or block list)."""
    if not text.startswith("---\n"):
        return []
    end = text.find("\n---", 4)
    if end < 0:
        return []
    pats, on = [], False
    for line in text[4:end].split("\n"):
        s = line.strip()
        if line.startswith("covers:"):
            rest = line[7:].strip()
            if rest:
                return [x.strip().strip("'\"") for x in rest.strip("[]").split(",") if x.strip()]
            on = True
        elif on and s.startswith("- "):
            pats.append(s[2:].strip().strip("'\""))
        elif on and s:
            break
    return pats


def docs(all_files):
    return {f: read(f) for f in all_files if f.lower().endswith(".md") and not f.startswith(SKIP)}


def covered(doc, text, all_files):
    """{file: hash} for the files a doc covers. Second value: patterns matching nothing."""
    now, dead = {}, []
    for pat in covers(text):
        rx = glob_re(pat)
        hits = [f for f in all_files if f != doc and rx.match(f)]
        if not hits:
            dead.append(pat)
        for f in hits:
            now[f] = digest(f)
    return now, dead


def load_lock():
    lock = {}
    path = ROOT / LOCK
    if path.is_file():
        for line in read(LOCK).split("\n"):
            parts = line.split("\t")
            if len(parts) == 3:
                lock.setdefault(parts[0], {})[parts[1]] = parts[2]
    return lock


def save_lock(lock):
    path = ROOT / LOCK
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"{d}\t{f}\t{h}" for d in sorted(lock) for f, h in sorted(lock[d].items())]
    # A blank line between entries lets git merge branches that changed different files.
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n\n".join(lines) + "\n")


# --- generators ------------------------------------------------------------

def cell(s):
    return str(s).replace("|", "\\|").replace("\n", " ")


def table(head, rows):
    out = ["| " + " | ".join(head) + " |", "|" + " --- |" * len(head)]
    return "\n".join(out + ["| " + " | ".join(cell(c) for c in r) + " |" for r in rows])


def g_tree(args, all_files, _docs):
    base = args[0].strip("/") if args and args[0] != "." else ""
    depth = int(args[1]) if len(args) > 1 else 2
    seen = set()
    for f in all_files:
        if base and not f.startswith(base + "/"):
            continue
        parts = f[len(base) + 1 if base else 0:].split("/")
        for i in range(1, min(len(parts), depth) + 1):
            seen.add((tuple(parts[:i]), i < len(parts)))
    pad = 1 if base else 0
    lines = [base + "/"] if base else []
    for parts, is_dir in sorted(seen):
        lines.append("  " * (len(parts) - 1 + pad) + parts[-1] + ("/" if is_dir else ""))
    return "```text\n" + "\n".join(lines) + "\n```"


def describe(path):
    """First line of a file's module docstring or leading comment."""
    text = read(path)
    if path.endswith(".py"):
        try:
            doc = ast.get_docstring(ast.parse(text))
        except SyntaxError:
            doc = None
        return doc.strip().split("\n")[0] if doc else ""
    for line in text.split("\n")[:30]:
        s = line.strip()
        if not s or s.startswith("#!"):
            continue
        m = re.match(r"(?://+|#+(?=\s|$)|/\*+|\*(?=\s|$)|--|<!--)\s*(.*?)\s*(?:\*/|-->)?$", s)
        if not m:
            return ""
        if m.group(1):
            return m.group(1)
    return ""


def g_docstrings(args, all_files, _docs):
    if not args:
        raise ValueError("docstrings needs a glob, e.g. docstrings src/**/*.py")
    rx = glob_re(args[0])
    rows = [(f"`{f}`", describe(f) or "(no description)") for f in all_files if rx.match(f)]
    return table(["File", "Purpose"], rows)


def g_scripts(args, _files, _docs):
    path = args[0] if args else "package.json"
    scripts = json.loads(read(path)).get("scripts", {})
    return table(["Command", "Runs"], [(f"`npm run {k}`", f"`{v}`") for k, v in sorted(scripts.items())])


def g_covers(_args, _files, all_docs):
    rows = [(f"`{d}`", ", ".join(f"`{p}`" for p in covers(t))) for d, t in sorted(all_docs.items()) if covers(t)]
    return table(["Document", "Covers"], rows)


def g_run(args, _files, _docs):
    if not args:
        raise ValueError("run needs a name from " + GENERATORS)
    try:
        cmd = json.loads(read(GENERATORS))[args[0]]
    except (OSError, KeyError, ValueError):
        raise ValueError(f"no command '{args[0]}' in {GENERATORS}")
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    if r.returncode:
        raise ValueError(f"generator '{args[0]}' failed: {r.stderr.strip()[:300]}")
    return r.stdout.replace("\r\n", "\n").strip("\n")


GEN = {"tree": g_tree, "docstrings": g_docstrings, "scripts": g_scripts, "covers": g_covers, "run": g_run}


def render(doc, text, all_files, all_docs):
    """Text with every generated block rewritten. Markers inside code fences are ignored."""
    lines, out, i, fence = text.split("\n"), [], 0, False
    while i < len(lines):
        line = lines[i]
        if line.lstrip().startswith("```"):
            fence = not fence
        m = None if fence else BEGIN.match(line.strip())
        if not m:
            out.append(line)
            i += 1
            continue
        try:
            j = next(k for k in range(i + 1, len(lines)) if lines[k].strip() == END)
        except StopIteration:
            raise ValueError(f"{doc}: block '{m.group(1)}' has no {END}")
        name, *args = m.group(1).split()
        if name not in GEN:
            raise ValueError(f"{doc}: unknown generator '{name}'")
        try:
            body = GEN[name](args, all_files, all_docs)
        except (OSError, ValueError) as e:
            raise ValueError(f"{doc}: block '{m.group(1)}': {e}")
        out += [line, *body.split("\n"), lines[j]]
        i = j + 1
    return "\n".join(out)


# --- commands --------------------------------------------------------------

def generate(quiet=False):
    all_files = files()
    all_docs = docs(all_files)
    failed = 0
    for doc, text in all_docs.items():
        try:
            new = render(doc, text, all_files, all_docs)
        except ValueError as e:
            failed = 1
            if not quiet:
                print(f"BROKEN {e}")
            continue
        if new != text:
            crlf = b"\r\n" in (ROOT / doc).read_bytes()
            (ROOT / doc).write_bytes(new.replace("\n", "\r\n" if crlf else "\n").encode("utf-8"))
            if not quiet:
                print(f"updated {doc}")
    return failed


def problems():
    all_files = files()
    all_docs = docs(all_files)
    lock = load_lock()
    found = []
    for doc, text in sorted(all_docs.items()):
        try:
            if render(doc, text, all_files, all_docs) != text:
                found.append(f"OUTDATED {doc}: a generated block no longer matches the code.\n"
                             f"  Fix: {ME} generate")
        except ValueError as e:
            found.append(f"BROKEN {e}")
        now, dead = covered(doc, text, all_files)
        for pat in dead:
            found.append(f"BROKEN {doc}: covers pattern '{pat}' matches no file. "
                         "Fix the pattern in the doc's frontmatter.")
        was = lock.get(doc, {})
        diff = [("A " if f not in was else "M ") + f for f in sorted(now) if was.get(f) != now[f]]
        diff += ["D " + f for f in sorted(was) if f not in now]
        if diff:
            shown = "\n".join("    " + d for d in diff[:20])
            more = f"\n    ... and {len(diff) - 20} more" if len(diff) > 20 else ""
            found.append(f"STALE {doc}: covered code changed since this doc was last reviewed:\n"
                         f"{shown}{more}\n"
                         "  Fix: read the doc and its diagrams against these changes, edit what is\n"
                         f"  no longer true, then: {ME} stamp {doc}")
    return found


def check():
    found = problems()
    if found:
        print("\n".join(found))
        print(f"\ndocs_sync: {len(found)} problem(s).")
        return 1
    print("docs_sync: docs are in sync.")
    return 0


def stamp(args):
    all_files = files()
    all_docs = docs(all_files)
    targets = sorted(all_docs) if "--all" in args else [Path(a).as_posix().removeprefix("./") for a in args]
    if not targets:
        print("usage: stamp DOC... | --all")
        return 1
    lock = {d: v for d, v in load_lock().items() if d in all_docs and covers(all_docs[d])}
    for doc in targets:
        if doc not in all_docs:
            print(f"not a tracked Markdown doc: {doc}")
            return 1
        now, _ = covered(doc, all_docs[doc], all_files)
        if now:
            lock[doc] = now
            print(f"stamped {doc} ({len(now)} files)")
        else:
            lock.pop(doc, None)
    save_lock(lock)
    return 0


def owners(args):
    all_files = files()
    paths = [Path(a).as_posix().removeprefix("./").rstrip("/") for a in args]
    wanted = {f for f in all_files for p in paths if f == p or f.startswith(p + "/")}
    for doc, text in sorted(docs(all_files).items()):
        now, _ = covered(doc, text, all_files)
        hit = sorted(wanted & set(now))
        if hit:
            print(f"{doc}: {len(hit)} file(s), e.g. {hit[0]}")
    return 0


def uncovered():
    all_files = files()
    seen = set()
    for doc, text in docs(all_files).items():
        seen |= set(covered(doc, text, all_files)[0])
    for f in all_files:
        if f not in seen and not f.lower().endswith(".md"):
            print(f)
    return 0


def hook():
    """Stop hook. Exit 2 with the report on stderr sends the model back to fix it.
    The same report twice in a row for one session lets the turn end, so it cannot loop."""
    try:
        data = json.load(sys.stdin)
    except ValueError:
        data = {}
    if data.get("cwd"):
        os.chdir(data["cwd"])
    if not set_root():
        return 0
    generate(quiet=True)  # broken blocks are reported by problems() below
    found = problems()
    session = re.sub(r"\W", "", str(data.get("session_id", "")))
    memo = Path(tempfile.gettempdir()) / f"docs_sync_{session or 'nosession'}.txt"
    if not found:
        memo.unlink(missing_ok=True)
        return 0
    report = "\n".join(found)
    key = hashlib.sha256(report.encode()).hexdigest()
    if memo.is_file() and memo.read_text() == key:
        return 0
    memo.write_text(key)
    print("Docs are out of sync with the code. Fix this before finishing:\n" + report, file=sys.stderr)
    return 2


def set_root():
    global ROOT
    r = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    if r.returncode:
        return False
    ROOT = Path(r.stdout.strip())
    return True


def main(argv):
    cmd, args = (argv[0], argv[1:]) if argv else ("", [])
    if cmd == "hook":
        return hook()
    if cmd not in ("generate", "check", "stamp", "owners", "uncovered"):
        print(__doc__)
        return 1
    if not set_root():
        print("docs_sync: not inside a git repository")
        return 1
    try:
        return {"generate": generate, "check": check, "uncovered": uncovered,
                "stamp": lambda: stamp(args), "owners": lambda: owners(args)}[cmd]()
    except ValueError as e:
        print(f"docs_sync: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

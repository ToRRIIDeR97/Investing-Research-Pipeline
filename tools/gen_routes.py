"""Print every API route under src/app/api with its HTTP methods as Markdown."""
import re
from pathlib import Path

METHODS = re.compile(r"export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b")
rows = []
for f in sorted(Path("src/app/api").rglob("route.ts")):
    parts = f.parent.relative_to("src/app").as_posix()
    methods = sorted(set(METHODS.findall(f.read_text(encoding="utf-8"))))
    rows.append(("/" + parts, ", ".join(methods)))
total = sum(len(m.split(", ")) for _, m in rows if m)
print(f"{len(rows)} route files, {total} handlers.")
print()
print("| Route | Methods |")
print("| --- | --- |")
for route, methods in sorted(rows):
    print(f"| `{route}` | {methods} |")

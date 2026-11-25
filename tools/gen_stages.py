"""Print the research stage table from src/lib/workflow/stages.ts as Markdown."""
import re
from pathlib import Path

text = Path("src/lib/workflow/stages.ts").read_text(encoding="utf-8")
body = text[text.index("STAGE_CONFIGS"):]
rows = []
for block in re.split(r"\n  \{\n", body)[1:]:
    def field(name, pattern=r"([^,\n]+)"):
        m = re.search(rf"\n\s*{name}:\s*{pattern}", "\n" + block)
        return m.group(1).strip().strip('"') if m else ""
    skips = re.findall(r'"([^"]+)"', field("skipForRunTypes", r"(\[[^\]]*\])"))
    rows.append((int(field("order")), field("key"), field("failureState"), field("maxRetries"),
                 "yes" if field("requiresHumanApproval") == "true" else "", ", ".join(skips)))
print("| # | Stage | failureState | Retries | Human gate | Skipped for |")
print("| --- | --- | --- | --- | --- | --- |")
for r in sorted(rows):
    print("| " + " | ".join(str(c) if c != "" else "" for c in r) + " |")

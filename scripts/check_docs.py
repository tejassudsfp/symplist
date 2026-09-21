"""Check local Markdown targets; no dependencies."""
from pathlib import Path
import re
import sys
from urllib.parse import unquote

root = Path(__file__).resolve().parents[1]
errors = []
for source in root.rglob("*.md"):
    if any(part in {".git", "node_modules", ".next"} for part in source.parts):
        continue
    for match in re.finditer(r"\]\((<[^>]+>|[^)]+)\)", source.read_text()):
        target = match.group(1).strip("<>")
        if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target) or target.startswith("#"):
            continue
        path = unquote(target.split("#", 1)[0])
        if path and not (source.parent / path).exists():
            errors.append(f"{source.relative_to(root)}: missing {path}")
if errors:
    print("\n".join(errors))
    sys.exit(1)
print("Local Markdown links verified.")

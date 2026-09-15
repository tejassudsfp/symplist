"""Check local Markdown targets and the design screen index; no dependencies."""
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
folder = root / "design/mockups"
master = (folder / "overall.md").read_text()
screens = [p for p in folder.glob("*.md") if p.name not in {"overall.md", "themes.md"}]
for screen in screens:
    if f"]({screen.name})" not in master:
        errors.append(f"Screen missing from master: {screen.name}")
for file in [root / "README.md", folder / "overall.md", root / "docs/prompts/build prompt.md"]:
    for count in re.findall(r"(?:all )?(\d+) (?:individual )?screen briefs", file.read_text()):
        if int(count) != len(screens):
            errors.append(f"{file.relative_to(root)}: stale screen count {count}")
if errors:
    print("\n".join(errors))
    sys.exit(1)
print(f"Local Markdown links and {len(screens)} screen briefs verified.")

import json
from pathlib import Path
import re
import sys

version = sys.argv[1]
match = re.fullmatch(r"([2-9][0-9]{3})\.([1-9]|1[0-2])\.([1-9][0-9]*)", version)
if not match or int(match[3]) > 4294967295:
    raise SystemExit("expected year.month.sequence")
for name in ("package.json", "package-lock.json"):
    path = Path(name)
    if path.exists():
        data = json.loads(path.read_text())
        data["version"] = version
        if "" in data.get("packages", {}):
            data["packages"][""]["version"] = version
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
meta = Path("backend/server/meta.mjs")
if meta.exists():
    content, count = re.subn(r"export const APP_VERSION = '[^']*';", f"export const APP_VERSION = '{version}';", meta.read_text(), count=1)
    if count != 1:
        raise SystemExit("backend version declaration not found")
    meta.write_text(content)

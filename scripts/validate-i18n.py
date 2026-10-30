from pathlib import Path
import json
root = Path(__file__).resolve().parent.parent
for p in (root / "i18n").glob("*.json"):
    json.loads(p.read_text(encoding="utf-8"))
print("Translation JSON validated")

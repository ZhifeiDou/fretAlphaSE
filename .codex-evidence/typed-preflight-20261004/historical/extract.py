"""Freeze historical FRET responses without copying unrelated session contents."""
import hashlib
import json
from pathlib import Path

ROOT = Path(r"C:\Cawl\smoking_record\nl2repo-stable-baselines3-20261004-cli-r2\evidence")
DEST = Path(__file__).resolve().parents[3] / "mcp/tests/fixtures/historical-failed-models.json"
AUDIT = ROOT / "fret-usage-timeout-audit-20261004-2120.json"


def sha(value):
    return "sha256:" + hashlib.sha256(value).hexdigest()


def parts(value):
    if isinstance(value, dict):
        if value.get("type") == "tool" and "state" in value:
            yield value
        else:
            for child in value.values():
                yield from parts(child)
    elif isinstance(value, list):
        for child in value:
            yield from parts(child)


audit = json.loads(AUDIT.read_text(encoding="utf-8"))
cases = []
for job in audit["summary"]["failed_jobs"]:
    found = None
    for origin in job["origins"]:
        stem = Path(origin["file"]).stem
        candidates = [ROOT / f'{stem}-{origin["session_id"]}.json', ROOT / origin["file"]]
        candidates += sorted(ROOT.glob(f'{stem}-{origin["session_id"]}*-snapshot.json'))
        for filename in candidates:
            if not filename.exists():
                continue
            raw = filename.read_bytes()
            matches = [p for p in parts(json.loads(raw)) if p["id"] == origin["part_id"]]
            if not matches:
                continue
            part = matches[0]
            output = part["state"]["output"]
            envelope = json.loads(output[output.index("{"):])
            original = envelope.get("value", envelope)
            assert original["job_id"] == job["job_id"]
            assert original["report"]["result"] == job["result"]
            found = {
                "component": job["component"],
                "provenance": {
                    "archive": str(filename),
                    "archive_sha256": sha(raw),
                    "session_id": part["sessionID"],
                    "message_id": part["messageID"],
                    "part_id": part["id"],
                    "tool": part["tool"],
                    "tool_input": part["state"]["input"],
                    "raw_output_sha256": sha(output.encode("utf-8")),
                    "resource_binding": {k: v for k, v in envelope.items() if k != "value"} if "value" in envelope else None,
                    "diagnostic_locations": "Historical formalization locations are preserved verbatim (including null); backend locations refer only to the preserved generated Lustre and stdout, not to FRETish source.",
                },
                "original": original,
            }
            break
        if found:
            break
    assert found, job["component"]
    cases.append(found)

DEST.write_text(json.dumps({
    "description": "Exact 16 failed jobs from the bounded 2026-10-04 historical audit; original inputs and reports are not corrected in place.",
    "audit": {"path": str(AUDIT), "sha256": sha(AUDIT.read_bytes())},
    "cases": cases,
}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Extracted {len(cases)} exact historical jobs into {DEST}")
for case in cases:
    print(case["component"], case["original"]["report"]["result"])
    print(json.dumps(case["original"]["input"], ensure_ascii=False, indent=2))

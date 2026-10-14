import datetime
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
originals = json.loads((ROOT / "mcp/tests/fixtures/historical-failed-models.json").read_text(encoding="utf-8"))
summary = json.loads((HERE / "linux-replay-summary.json").read_text(encoding="utf-8"))
image = "alphase/fret-mcp:typed-preflight-20261004-r1"
mounts = "--mount 'type=bind,source=C:\\fretAlphaSE\\mcp\\tests,target=/opt/fret-mcp/tests,readonly' --mount 'type=bind,source=C:\\fretAlphaSE\\mcp\\src,target=/opt/fret-mcp/src,readonly'"


def digest(filename):
    return "sha256:" + hashlib.sha256(filename.read_bytes()).hexdigest()


files = [ROOT / "mcp/tests/historical-models.test.js", ROOT / "mcp/tests/fixtures/historical-failed-models.json", ROOT / "mcp/tests/fixtures/historical-corrected-models.json"]
files += [HERE / f'{case["component"]}.json' for case in originals["cases"]]
files += [HERE / name for name in ["extract.py", "corrections.py", "replay.cjs", "public-preflight.json", "linux-replay-summary.json", "linux-replay.log", "linux-tests.log", "windows-tests.log"]]
record = {
    "recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "scope": "Historical 16-model regression only, separate from generic tests and AlphaSE deployment/agent behavior acceptance.",
    "historical_models": 16,
    "historical_requirements": 38,
    "explicitly_corrected_clauses": 28,
    "original_replay": {"invalid": 16, "contract_checks": 0, "note": "Backend version probes may run; no contract/diagnosis solver check was issued."},
    "corrected_replay": {"formalized_clauses": 38, "realizable": 15, "unknown": 1, "unresolved": ["RMSpropTFLikeNumerics: complete nine-clause nonlinear model reaches the unchanged 60-second Kind 2 timeout, exit 30, Wallclock timeout; no proof obtained."]},
    "image": {"tag": image, "id": "sha256:6dcf4d5be231e177af224f38915333aa429db429c82b064e1d363de4bf4c7a49"},
    "source_build_identity_record": "../source-build.json",
    "report_toolchain": summary[0]["toolchain"],
    "commands": [
        {"cwd": "C:\\fretAlphaSE\\mcp", "command": "node --test tests/historical-models.test.js", "exit_code": 0, "passed": 33, "failed": 0, "skipped": 16, "log": "windows-tests.log"},
        {"cwd": "C:\\fretAlphaSE", "command": f"docker run --rm --init --network none {mounts} --mount 'type=bind,source=C:\\fretAlphaSE\\.codex-evidence\\typed-preflight-20261004\\historical,target=/evidence' {image} node /evidence/replay.cjs", "exit_code": 0, "note": "Evidence collection: 16 complete original/corrected analysis report pairs, not a separate passing-test count.", "log": "linux-replay.log"},
        {"cwd": "C:\\fretAlphaSE", "command": f"docker run --rm --init --network none {mounts} {image} node --test tests/historical-models.test.js", "exit_code": 0, "passed": 49, "failed": 0, "skipped": 0, "log": "linux-tests.log"},
    ],
    "files": [{"path": str(filename.relative_to(ROOT)), "sha256": digest(filename)} for filename in files],
}
(HERE / "result.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"models": 16, "windows": [33, 0, 16], "linux": [49, 0, 0], "realizable": 15, "unknown": 1}))

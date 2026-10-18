"""CLI wrapper so the TypeScript side can compare verdicts with this one.

    python -m comfyrizz_pipeline.validate <package.json | -> [--json] [--defaults] [--jobs]

Exit 0 valid, 1 invalid, 2 usage/IO error. Output shape matches
packages/schema/bin/comfyrizz-validate.mjs so the conformance tests can diff codes.

**``--jobs`` validates a ``jobs.json`` instead of a package** (GPU test 2, issue 7: the CLI used to
report a plan's job ids as missing package fields, which reads as "the plan is broken" when it is
simply a different document). The mode is also auto-detected: a document with ``jobs`` and no
``scenes`` is a plan. A plan check is the runner's own gate — job ids unique, every dependency and
file input resolvable, paths relative, stage-1 lattice half the output — so the answer here is the
one the runner would give.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .schema import validate_jobs, validate_package


def _report(path: str, doc) -> dict:
    result = validate_package(doc)
    return {
        "file": path,
        "kind": "package",
        "valid": result["valid"],
        "schemaOk": result["schemaOk"],
        "errors": result["errors"],
        "warnings": result["warnings"],
        "motion": result["motion"],
    }


def _jobs_report(path: str, doc, *, forced: bool) -> dict:
    problems = validate_jobs(doc)
    errors = [
        {"source": "schema" if problem["code"].startswith("JOBS_") else "semantic", **problem}
        for problem in problems
    ]
    return {
        "file": path,
        "kind": "jobs",
        "detected": not forced,
        "valid": not errors,
        "schemaOk": not any(error["source"] == "schema" for error in errors),
        "errors": errors,
        "warnings": [],
    }


def looks_like_a_plan(doc) -> bool:
    return isinstance(doc, dict) and "jobs" in doc and "scenes" not in doc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="comfyrizz_pipeline.validate", add_help=True)
    parser.add_argument("files", nargs="+", help="package.json (or jobs.json) path, or - for stdin")
    parser.add_argument("--json", action="store_true", help="machine-readable report")
    parser.add_argument("--defaults", action="store_true", help="apply declared defaults first")
    parser.add_argument("--codes", action="store_true", help="print only sorted error codes per file")
    parser.add_argument("--jobs", action="store_true", help="treat every file as a jobs.json plan")
    parser.add_argument("--package", action="store_true", help="treat every file as a package (no auto-detect)")
    args = parser.parse_args(argv)
    if args.jobs and args.package:
        print("error: --jobs and --package are mutually exclusive", file=sys.stderr)
        return 2

    reports = []
    failed = False
    for name in args.files:
        try:
            text = sys.stdin.read() if name == "-" else Path(name).read_text(encoding="utf-8")
        except OSError as exc:
            print(f"cannot read {name}: {exc}", file=sys.stderr)
            return 2
        try:
            doc = json.loads(text)
        except json.JSONDecodeError as exc:
            reports.append(
                {
                    "file": name,
                    "kind": "unknown",
                    "valid": False,
                    "schemaOk": False,
                    "errors": [{"source": "parse", "code": "PARSE_JSON", "path": "", "message": str(exc)}],
                    "warnings": [],
                }
            )
            failed = True
            continue
        as_jobs = args.jobs or (not args.package and looks_like_a_plan(doc))
        report = _jobs_report(name, doc, forced=args.jobs) if as_jobs else _report(name, doc)
        if args.defaults and not as_jobs:
            report["document"] = validate_package(doc, defaults=True)["document"]
        if not report["valid"]:
            failed = True
        reports.append(report)

    if args.codes:
        for report in reports:
            print(" ".join(sorted({e["code"] for e in report["errors"]})))
    elif args.json:
        print(json.dumps(reports[0] if len(reports) == 1 else reports, indent=2))
    else:
        for report in reports:
            status = "VALID" if report["valid"] else "INVALID"
            if report["valid"] and report["warnings"]:
                status = "VALID (warnings)"
            kind = " (jobs)" if report.get("kind") == "jobs" else ""
            print(f"{status}  {report['file']}{kind}")
            for err in report["errors"]:
                print(f"  error  {err['code']} {err['path']} - {err['message']}")
            for warn in report["warnings"]:
                print(f"  warn   {warn['code']} {warn['path']} - {warn['message']}")
            # MS2: advisory motion lint (never changes the verdict); info findings only in --json.
            for item in report.get("motion", []):
                if item["severity"] != "info":
                    fixable = " [autofix]" if item["autofix"] else ""
                    print(f"  motion {item['severity']} {item['code']} {item['path']} - {item['message']}{fixable}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

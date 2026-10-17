"""CLI wrapper so the TypeScript side can compare verdicts with this one.

    python -m comfyrizz_pipeline.validate <package.json | -> [--json] [--defaults]

Exit 0 valid, 1 invalid, 2 usage/IO error. Output shape matches
packages/schema/bin/comfyrizz-validate.mjs so the conformance tests can diff codes.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .schema import validate_package


def _report(path: str, doc) -> dict:
    result = validate_package(doc)
    return {
        "file": path,
        "valid": result["valid"],
        "schemaOk": result["schemaOk"],
        "errors": result["errors"],
        "warnings": result["warnings"],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="comfyrizz_pipeline.validate", add_help=True)
    parser.add_argument("files", nargs="+", help="package.json path, or - for stdin")
    parser.add_argument("--json", action="store_true", help="machine-readable report")
    parser.add_argument("--defaults", action="store_true", help="apply declared defaults first")
    parser.add_argument("--codes", action="store_true", help="print only sorted error codes per file")
    args = parser.parse_args(argv)

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
                    "valid": False,
                    "schemaOk": False,
                    "errors": [{"source": "parse", "code": "PARSE_JSON", "path": "", "message": str(exc)}],
                    "warnings": [],
                }
            )
            failed = True
            continue
        report = _report(name, doc)
        if args.defaults:
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
            print(f"{status}  {report['file']}")
            for err in report["errors"]:
                print(f"  error  {err['code']} {err['path']} - {err['message']}")
            for warn in report["warnings"]:
                print(f"  warn   {warn['code']} {warn['path']} - {warn['message']}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

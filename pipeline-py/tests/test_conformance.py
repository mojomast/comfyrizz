"""B1 acceptance: Python and TypeScript agree on the whole shared fixture corpus.

Mirror of packages/schema/test/conformance.test.mjs (the TypeScript side runs the
Python validator; this side runs node). If node is unavailable the test skips with a
loud reason instead of pretending to have checked.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from comfyrizz_pipeline import schema as S

REPO = S.repo_root()
FIXTURES = REPO / "packages" / "schema" / "fixtures"
CLI = REPO / "packages" / "schema" / "bin" / "comfyrizz-validate.mjs"
MANIFEST = json.loads((FIXTURES / "manifest.json").read_text(encoding="utf-8"))
NODE = shutil.which("node")


def node_report(path: Path) -> dict:
    run = subprocess.run(
        [NODE, str(CLI), str(path), "--json"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert run.returncode in (0, 1), f"node validator failed: {run.stderr}"
    return json.loads(run.stdout)


@pytest.mark.skipif(NODE is None, reason="node not on PATH, cannot run the TypeScript validator")
def test_both_implementations_agree_on_every_fixture():
    disagreements = []
    for entry in MANIFEST["fixtures"]:
        path = FIXTURES / entry["file"]
        py = S.validate_package(json.loads(path.read_text(encoding="utf-8")))
        ts = node_report(path)
        if bool(ts["schemaOk"]) is not bool(py["schemaOk"]):
            disagreements.append(f"{entry['file']}: schemaOk py={py['schemaOk']} ts={ts['schemaOk']}")
        for code in entry.get("schemaCodes") or []:
            # libraries word structural findings differently, so the shared claim is the
            # verdict plus every structural code the fixture declares, on both sides
            in_py = any(e["source"] == "schema" and e["code"] == code for e in py["errors"])
            in_ts = any(e["source"] == "schema" and e["code"] == code for e in ts["errors"])
            if not (in_py and in_ts):
                disagreements.append(f"{entry['file']}: declared structural code {code} py={in_py} ts={in_ts}")
        py_sem = sorted(f"{e['code']}{e['path']}" for e in py["semantic"])
        ts_sem = sorted(f"{e['code']}{e['path']}" for e in ts["errors"] if e["source"] == "semantic")
        if py_sem != ts_sem:
            disagreements.append(f"{entry['file']}: semantic py={py_sem} ts={ts_sem}")
        if py["valid"] is not ts["valid"]:
            disagreements.append(f"{entry['file']}: valid py={py['valid']} ts={ts['valid']}")
    assert not disagreements, "\n".join(disagreements)


@pytest.mark.skipif(NODE is None, reason="node not on PATH, cannot run the TypeScript validator")
def test_both_implementations_agree_on_defaults():
    path = FIXTURES / "valid" / "defaults-unfilled.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    py = S.apply_defaults(doc)
    run = subprocess.run(
        [
            NODE,
            "-e",
            "import('./src/index.mjs').then(async(m)=>{const fs=await import('node:fs');"
            "const doc=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));"
            "console.log(JSON.stringify(m.applyDefaults(doc,m.loadSchema())));});",
            str(path),
        ],
        cwd=REPO / "packages" / "schema",
        capture_output=True,
        text=True,
        check=False,
    )
    assert run.returncode == 0, run.stderr
    ts = json.loads(run.stdout)
    assert ts["scenes"][0] == py["scenes"][0]
    assert ts["assets"] == py["assets"]
    assert ts["datasets"] == py["datasets"]


def test_node_and_python_see_the_same_corpus():
    assert NODE is not None or True  # corpus check does not need node
    assert len(MANIFEST["fixtures"]) >= 30
    for entry in MANIFEST["fixtures"]:
        assert (FIXTURES / entry["file"]).is_file(), entry["file"]

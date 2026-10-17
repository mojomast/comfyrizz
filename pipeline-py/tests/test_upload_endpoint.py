"""H-fix6: uploads must reach ComfyUI, not the v2 proxy (GPU test 3).

The failure this prevents is the one the GPU test 3 run hit: the runner's deployment root is the
v2 proxy (`comfy-api-proxy` on 8189), the proxy serves `/api/v2` and *not* ComfyUI's native
`/upload/image`, so **5 of 10 jobs** failed with `upload_unsupported` — and the run only finished
because somebody remembered to add `--upload-url http://127.0.0.1:8188/upload/image` by hand.

So the endpoint is now resolved and recorded rather than assumed:

    explicit (--upload-url)  ->  remembered (this deployment's own cache)  ->  declared
    (--comfyui-url/COMFYUI_URL)  ->  the deployment root  ->  ComfyUI behind the declared
    port pairing (COMFYRIZZ_PROXY_PORT 8189 -> COMFYRIZZ_COMFY_PORT 8188)

An explicit endpoint stays an instruction: it is the only candidate tried, so a deliberate
pointer is never quietly overridden. Everything else falls through, and the endpoint that
actually took the bytes is what the progress log, the manifest and the upload cache record.

No GPU, no network beyond loopback.
"""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest

from comfyrizz_pipeline.client import (
    BASE_URL_ENV,
    COMFY_PORT_ENV,
    COMFYUI_URL_ENV,
    PROXY_PORT_ENV,
    UPLOAD_ROUTE,
    ComfyClient,
    comfyui_origin_for,
    upload_endpoints,
    upload_route_url,
)
from comfyrizz_pipeline.progress import ProgressWriter
from comfyrizz_pipeline.runner import Runner, RunnerConfig

from conftest import REPO_ROOT, load_jsonl
from fake_comfy import UPLOAD_PATH
from test_file_inputs import jobs_doc, plate_job, still_job, workspace

PROXY = "http://127.0.0.1:8189"


@pytest.fixture(autouse=True)
def _no_leaked_deployment_env(monkeypatch: pytest.MonkeyPatch):
    """Start every test with no deployment environment.

    `ComfyClient.client` writes `COMFY_BASE_URL` into the process env on purpose ("one client per
    runner process"), so a test that runs after one must not inherit its port — the endpoint
    resolution falls back to the environment when it is not told otherwise.
    """
    for name in (BASE_URL_ENV, COMFYUI_URL_ENV, "COMFY_UPLOAD_URL", PROXY_PORT_ENV, COMFY_PORT_ENV):
        monkeypatch.delenv(name, raising=False)


# --------------------------------------------------------------------- the endpoint contract


def test_the_proxy_root_names_comfyui_behind_the_declared_pairing():
    assert comfyui_origin_for(PROXY) == "http://127.0.0.1:8188"
    assert comfyui_origin_for("http://localhost:8189/") == "http://localhost:8188"
    # ComfyUI itself, a forwarded port, and somebody else's host are not the pairing
    assert comfyui_origin_for("http://127.0.0.1:8188") is None
    assert comfyui_origin_for("http://127.0.0.1:9819") is None
    assert comfyui_origin_for("https://comfy.example.com") is None
    assert comfyui_origin_for(None) is None
    assert comfyui_origin_for("not a url") is None


def test_the_pairing_ports_are_the_deployment_of_its_own(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv(PROXY_PORT_ENV, "9001")
    monkeypatch.setenv(COMFY_PORT_ENV, "9002")
    assert comfyui_origin_for("http://127.0.0.1:9001") == "http://127.0.0.1:9002"
    assert comfyui_origin_for(PROXY) is None, "8189 is no longer this deployment's proxy port"
    # a typo must not take a run down: the rule simply does not apply
    monkeypatch.setenv(COMFY_PORT_ENV, "eight thousand")
    assert comfyui_origin_for("http://127.0.0.1:9001") == "http://127.0.0.1:8188"


def test_a_bare_origin_becomes_the_upload_route():
    assert upload_route_url("http://127.0.0.1:8188") == f"http://127.0.0.1:8188{UPLOAD_ROUTE}"
    assert upload_route_url("http://127.0.0.1:8188/") == f"http://127.0.0.1:8188{UPLOAD_ROUTE}"
    assert upload_route_url(f"http://127.0.0.1:8188{UPLOAD_ROUTE}") == f"http://127.0.0.1:8188{UPLOAD_ROUTE}"


def test_the_endpoint_order_is_what_the_deployment_knows_best_first():
    assert upload_endpoints() == []
    # a root that is not the paired proxy is used as-is (the local, proxy-less deployment)
    assert upload_endpoints("http://127.0.0.1:9819") == [f"http://127.0.0.1:9819{UPLOAD_ROUTE}"]
    assert upload_endpoints(PROXY) == [f"{PROXY}{UPLOAD_ROUTE}", f"http://127.0.0.1:8188{UPLOAD_ROUTE}"]
    assert upload_endpoints(PROXY, declared="http://127.0.0.1:8188") == [
        f"http://127.0.0.1:8188{UPLOAD_ROUTE}",
        f"{PROXY}{UPLOAD_ROUTE}",
    ], "a declaration is used before the root that does not forward uploads"
    assert upload_endpoints(PROXY, preferred=["http://127.0.0.1:8188"]) == [
        f"http://127.0.0.1:8188{UPLOAD_ROUTE}",
        f"{PROXY}{UPLOAD_ROUTE}",
    ]
    # one endpoint, once, however many ways the same origin is named
    assert upload_endpoints(PROXY, declared="http://127.0.0.1:8188", preferred=["http://127.0.0.1:8188"]) == [
        f"http://127.0.0.1:8188{UPLOAD_ROUTE}",
        f"{PROXY}{UPLOAD_ROUTE}",
    ]


def test_an_explicit_endpoint_is_an_instruction_and_the_only_candidate():
    endpoints = upload_endpoints(
        PROXY, explicit="http://127.0.0.1:9999", preferred=["http://127.0.0.1:8188"], declared="http://127.0.0.1:8188"
    )
    assert endpoints == [f"http://127.0.0.1:9999{UPLOAD_ROUTE}"]


def test_the_base_url_env_is_the_root_when_no_base_url_is_given(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv(BASE_URL_ENV, PROXY)
    assert upload_endpoints() == [f"{PROXY}{UPLOAD_ROUTE}", f"http://127.0.0.1:8188{UPLOAD_ROUTE}"]


def test_the_client_says_how_the_endpoint_was_chosen():
    proxy = ComfyClient(base_url=PROXY)
    assert proxy.upload_url == f"{PROXY}{UPLOAD_ROUTE}"
    assert proxy.resolve_upload()["chosen_by"] == "first_candidate"

    declared = ComfyClient(base_url=PROXY, comfyui_url="http://127.0.0.1:8188")
    assert declared.upload_url == f"http://127.0.0.1:8188{UPLOAD_ROUTE}"
    assert declared.resolve_upload()["chosen_by"] == "declared"
    assert declared.upload_endpoints == [f"http://127.0.0.1:8188{UPLOAD_ROUTE}", f"{PROXY}{UPLOAD_ROUTE}"]

    explicit = ComfyClient(base_url=PROXY, upload_url="http://127.0.0.1:9999")
    assert explicit.resolve_upload()["chosen_by"] == "explicit"
    assert explicit.upload_endpoints == [f"http://127.0.0.1:9999{UPLOAD_ROUTE}"]

    remembered = ComfyClient(base_url=PROXY, preferred_upload_urls=["http://127.0.0.1:8188"])
    assert remembered.resolve_upload()["chosen_by"] == "remembered"


def test_a_client_with_nowhere_to_upload_says_which_knobs_exist(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv(BASE_URL_ENV, raising=False)
    from comfyrizz_pipeline.client import UploadError

    with pytest.raises(UploadError) as raised:
        ComfyClient().upload_url
    assert raised.value.code == "upload_url_unknown"
    assert "--comfyui-url" in raised.value.message and UPLOAD_ROUTE in raised.value.message


# --------------------------------------------------------------- the run, against two fakes


def runner_without_a_client(work: Path, **overrides) -> Runner:
    """A Runner that builds its own client from the config, as the CLI does."""
    config = RunnerConfig(
        jobs_file=work / "jobs.json",
        out_dir=work / "out",
        poll_interval=0.05,
        job_timeout=10.0,
        reconcile_timeout=10.0,
        echo_progress=False,
        progress_path=work / "progress.jsonl",
    )
    for key, value in overrides.items():
        setattr(config, key, value)
    writer = ProgressWriter(stream=io.StringIO(), echo=False, path=config.progress_path)
    return Runner(config, progress=writer)


def upload_statuses(fake) -> list[int]:
    """The status of every /upload/image call (the fake records `status` only when it refuses)."""
    return [entry.get("status", 200) for entry in fake.upload_requests()]


def test_a_declared_comfyui_origin_takes_the_upload_off_the_proxy(tmp_path: Path, servers):
    """What `colab/run_jobs.py` and the BYO backend now do: say where ComfyUI is."""
    proxy = servers(upload_status=404)  # comfy-api-proxy: v2 only, no native upload route
    comfy = servers()  # ComfyUI itself
    work = workspace(tmp_path)
    manifest = runner_without_a_client(work, base_url=proxy.base_url, comfyui_url=comfy.base_url).run()

    assert manifest["counts"] == {"succeeded": 2}, manifest
    assert upload_statuses(proxy) == [], "the proxy was never asked: the declaration was used first"
    assert upload_statuses(comfy) == [200]
    assert result_error_code(manifest, "a_plate.plate") is None

    # the uploads went to ComfyUI, the jobs went to the proxy, and the graph carries the name the
    # uploading server returned
    assert proxy.state.submit_count() == 2, "the jobs still run on the deployment root"
    graph = proxy.submitted_workflows()[1]
    assert graph["1"]["inputs"]["image"] == next(iter(comfy.state.uploads))
    assert comfy.state.submit_count() == 0, "ComfyUI took the file, not the job"

    # the cache keys the name to that endpoint, and remembers it for the next run
    cache = json.loads((work / "out" / "cache" / "uploads.json").read_text(encoding="utf-8"))
    assert cache["endpoints"][proxy.base_url] == f"{comfy.base_url}{UPLOAD_ROUTE}"
    assert list(cache["entries"].values())[0]["url"] == f"{comfy.base_url}{UPLOAD_ROUTE}"

    events = load_jsonl(work / "progress.jsonl")
    endpoint = next(event for event in events if event["event"] == "upload_endpoint")
    assert endpoint["value"]["url"] == f"{comfy.base_url}{UPLOAD_ROUTE}"
    assert endpoint["value"]["chosen_by"] == "declared"
    assert endpoint["value"]["candidates"][0] == f"{comfy.base_url}{UPLOAD_ROUTE}"
    assert len([event for event in events if event["event"] == "upload_done"]) == 1, "one file, one upload"


def test_the_proxy_is_walked_past_when_nobody_declared_anything(tmp_path: Path, servers, monkeypatch: pytest.MonkeyPatch):
    """The fallback, without a flag: the root refuses, ComfyUI behind the pairing takes it."""
    proxy = servers(upload_status=404)
    comfy = servers()
    proxy_port = int(proxy.base_url.rsplit(":", 1)[1])
    comfy_port = int(comfy.base_url.rsplit(":", 1)[1])
    monkeypatch.setenv(PROXY_PORT_ENV, str(proxy_port))
    monkeypatch.setenv(COMFY_PORT_ENV, str(comfy_port))

    work = workspace(tmp_path)
    manifest = runner_without_a_client(work, base_url=proxy.base_url).run()

    assert manifest["counts"] == {"succeeded": 2}, manifest
    assert upload_statuses(proxy) == [404], "the root was tried once and correctly judged wrong"
    assert upload_statuses(comfy) == [200]
    assert any("upload_unsupported" not in note for note in manifest["notes"])

    note = next(note for note in manifest["notes"] if "uploaded to" in note)
    assert f"{comfy.base_url}{UPLOAD_ROUTE}" in note and f"{proxy.base_url}{UPLOAD_ROUTE}" in note

    events = load_jsonl(work / "progress.jsonl")
    endpoint = next(event for event in events if event["event"] == "upload_endpoint")
    assert endpoint["value"]["url"] == f"{comfy.base_url}{UPLOAD_ROUTE}"
    assert endpoint["value"]["chosen_by"] == "upload", "the upload decided, not the ordering"

    # and the discovery is paid once: the next run starts at the endpoint that worked
    again = runner_without_a_client(work, base_url=proxy.base_url)
    assert again.client.upload_endpoints[0] == f"{comfy.base_url}{UPLOAD_ROUTE}"
    assert again.client.resolve_upload()["chosen_by"] == "remembered"
    assert again._remembered_upload_urls() == [f"{comfy.base_url}{UPLOAD_ROUTE}"]


def test_an_explicit_endpoint_is_not_papered_over_by_a_fallback(tmp_path: Path, servers):
    """A deliberate `--upload-url` is answered honestly: no silent jump to another server."""
    proxy = servers(upload_status=404)
    comfy = servers()
    work = workspace(tmp_path)
    manifest = runner_without_a_client(
        work,
        base_url=proxy.base_url,
        comfyui_url=comfy.base_url,
        upload_url=f"{proxy.base_url}{UPLOAD_ROUTE}",
    ).run()

    failed = result_error(manifest, "a_plate.plate")
    assert failed["code"] == "upload_unsupported"
    assert upload_statuses(comfy) == [], "an explicit endpoint must not fall through to another one"
    assert upload_statuses(proxy) == [404]
    assert proxy.state.submit_count("a_plate.plate") == 0
    # the still needs no input file, so it still ran: a refusal is scoped to one job
    assert manifest["counts"] == {"succeeded": 1, "failed": 1}


def test_every_endpoint_tried_is_named_when_none_of_them_serves_the_route(
    tmp_path: Path, servers, monkeypatch: pytest.MonkeyPatch
):
    proxy = servers(upload_status=404)
    comfy = servers(upload_status=405)
    monkeypatch.setenv(PROXY_PORT_ENV, str(proxy.base_url.rsplit(":", 1)[1]))
    monkeypatch.setenv(COMFY_PORT_ENV, str(comfy.base_url.rsplit(":", 1)[1]))

    work = workspace(tmp_path)
    manifest = runner_without_a_client(work, base_url=proxy.base_url).run()

    failed = result_error(manifest, "a_plate.plate")
    assert failed["code"] == "upload_unsupported"
    assert UPLOAD_ROUTE in failed["message"]
    # both endpoints, and why each was rejected, are in the message a human reads at 2am
    assert f"{proxy.base_url}{UPLOAD_ROUTE} -> upload_unsupported" in failed["message"]
    assert f"{comfy.base_url}{UPLOAD_ROUTE} -> upload_unsupported" in failed["message"]
    assert "--upload-url" in failed["message"] and COMFYUI_URL_ENV in failed["message"]
    assert proxy.state.submit_count("a_plate.plate") == 0 and comfy.state.submit_count("a_plate.plate") == 0


def test_a_bare_comfyui_origin_is_enough_of_a_declaration(tmp_path: Path, servers):
    """`--comfyui-url http://127.0.0.1:8188` (no route) is what a human will actually type."""
    proxy = servers(upload_status=404)
    comfy = servers()
    work = workspace(tmp_path)
    manifest = runner_without_a_client(work, base_url=proxy.base_url, comfyui_url=comfy.base_url.rsplit("/upload", 1)[0]).run()
    assert manifest["counts"] == {"succeeded": 2}, manifest
    assert upload_statuses(comfy) == [200]


def test_a_root_that_is_comfyui_keeps_working_with_no_declaration(tmp_path: Path, servers):
    """The local, proxy-less deployment (B5/B7 behaviour) must not change."""
    comfy = servers()
    work = workspace(tmp_path)
    manifest = runner_without_a_client(work, base_url=comfy.base_url).run()

    assert manifest["counts"] == {"succeeded": 2}, manifest
    assert upload_statuses(comfy) == [200]
    assert len(comfy.upload_requests()) == 1, "one file, uploaded once"
    assert not [note for note in manifest.get("notes", []) if "uploaded to" in note], "no note: the root is the endpoint"


# ------------------------------------------------------------------- the Google Colab runner


def load_run_jobs(name: str = "colab_run_jobs"):
    """Load `colab/run_jobs.py` by path (it is uploaded to the VM as a script, not a package)."""
    import importlib.util

    path = REPO_ROOT / "colab" / "run_jobs.py"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_the_vm_runner_declares_comfyui_beside_the_proxy(monkeypatch: pytest.MonkeyPatch):
    """The VM path must not need the flag that GPU test 3 needed by hand."""
    monkeypatch.delenv("COMFYRIZZ_COMFY_PORT", raising=False)
    module = load_run_jobs()
    command = module.runner_command(Path("/content/comfyrizz/work/jobs.json"), Path("/content/comfyrizz/out"))

    assert command[command.index("--base-url") + 1] == "http://127.0.0.1:8189"
    assert command[command.index("--comfyui-url") + 1] == "http://127.0.0.1:8188"
    assert command[command.index("--out") + 1] == "/content/comfyrizz/out"
    assert "--upload-url" not in command, "nothing to remember: the origin is declared"
    assert "--batch" not in command, "no selector: the whole plan runs"

    with_batch = module.runner_command(Path("/content/comfyrizz/work/jobs.json"), Path("/content/comfyrizz/out"), "plates")
    assert with_batch[with_batch.index("--batch") + 1] == "plates"


def test_the_vm_runner_follows_a_moved_comfyui_port(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("COMFYRIZZ_COMFY_PORT", "9101")
    module = load_run_jobs("colab_run_jobs_moved")
    command = module.runner_command(Path("/tmp/jobs.json"), Path("/tmp/out"))
    assert command[command.index("--comfyui-url") + 1] == "http://127.0.0.1:9101"


# ------------------------------------------------------------------------------- test helpers


def result_error(manifest: dict, job_id: str) -> dict:
    entry = next(item for item in manifest["jobs"] if item["job"] == job_id)
    assert entry["status"] == "failed", entry
    return entry["error"]


def result_error_code(manifest: dict, job_id: str) -> str | None:
    entry = next(item for item in manifest["jobs"] if item["job"] == job_id)
    return (entry.get("error") or {}).get("code")


def test_the_fixtures_used_here_are_the_upload_ones():
    """A guard against the fixture drifting out from under the tests above."""
    doc = jobs_doc([still_job(), plate_job()])
    assert [job["id"] for job in doc["jobs"]] == ["a_src.still", "a_plate.plate"]
    assert doc["jobs"][1]["fileInputs"][0]["param"] == "image"
    assert UPLOAD_PATH == UPLOAD_ROUTE

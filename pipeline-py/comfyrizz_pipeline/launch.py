"""Launch the runner as a **child process**, and patch the SDK safely when you must.

GPU test 2, issue 9. The failure mode: a Google Colab kernel (or any long-lived REPL) patched
``ComfyClient.submit`` in place and then ran the runner with ``runpy`` in the *same* interpreter.
The second run wrapped the wrapper, so every submit recursed until the kernel raised
``RecursionError`` — and the whole session was already billed.

Two supported ways out, in order of preference:

1. :func:`run_jobs` — start ``python -m comfyrizz_pipeline.runner`` as a subprocess. Module state,
   SDK imports and any monkeypatch die with the child, so run it as many times as you like from one
   process. This is what the Google Colab driver script should do (ask the runner for real GPU work).
2. :func:`install_metadata_shim` — if a *server* forces in-process patching (the
   ``comfy-api-proxy`` metadata quirk), install this once. It is idempotent: a second install is a
   no-op rather than a second wrapper, and :func:`uninstall_metadata_shim` puts the original back,
   which is the property that makes a double install safe instead of recursive.

The runner itself already handles the metadata refusal with an automatic fallback to labels-off
(``client.classify_metadata_refusal``, README "Job labels"), so the shim is only for a caller that
cannot use the child-process path at all.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable, Sequence

#: The pipeline package's parent directory — what ``python -m comfyrizz_pipeline.runner`` needs on
#: ``PYTHONPATH`` when the package is not installed into the environment (the box's ``.venv``).
PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def runner_argv(
    jobs: str | os.PathLike[str],
    out: str | os.PathLike[str],
    *,
    base_url: str | None = None,
    progress_log: str | os.PathLike[str] | None = None,
    reconcile: bool = False,
    batch: str | None = None,
    timeout: float | None = None,
    job_labels: bool | None = None,
    quiet: bool = True,
    extra: Sequence[str] = (),
) -> list[str]:
    """The argv for one runner invocation. Every flag here is the CLI's own (no private hooks)."""
    argv = ["-m", "comfyrizz_pipeline.runner", "--jobs", str(jobs), "--out", str(out)]
    if base_url:
        argv += ["--base-url", str(base_url)]
    if progress_log:
        argv += ["--progress-log", str(progress_log)]
    if reconcile:
        argv += ["--reconcile"]
    if batch:
        argv += ["--batch", str(batch)]
    if timeout is not None:
        argv += ["--timeout", str(timeout)]
    if job_labels is True:
        argv += ["--job-labels"]
    elif job_labels is False:
        argv += ["--no-job-labels"]
    if quiet:
        argv += ["--quiet"]
    return argv + [str(item) for item in extra]


def run_jobs(
    jobs: str | os.PathLike[str],
    out: str | os.PathLike[str],
    *,
    python: str | None = None,
    env: dict[str, str] | None = None,
    timeout: float | None = 3600.0,
    **argv_options: Any,
) -> subprocess.CompletedProcess:
    """Run the runner once, in a subprocess, and return the completed process.

    Nothing about this call changes the calling interpreter: that is the point. Call it twice —
    or twenty times — from one Google Colab kernel and each run gets a fresh SDK import.
    """
    command = [python or sys.executable, *runner_argv(jobs, out, **argv_options)]
    environment = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join(
            [str(PACKAGE_ROOT), *(p for p in [os.environ.get("PYTHONPATH")] if p)]
        ),
        **(env or {}),
    }
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        env=environment,
        timeout=timeout,
    )


def run_sequence(calls: Sequence[dict[str, Any]], **common: Any) -> list[subprocess.CompletedProcess]:
    """``run_jobs`` once per entry in `calls` (each a kwargs dict), in order."""
    return [run_jobs(**{**common, **call}) for call in calls]


# ------------------------------------------------------------------ the in-process escape hatch

#: Marks a patched method, so a second install can tell a wrapper from a real implementation.
SHIM_MARKER = "__comfyrizz_metadata_shim__"
_WRAPPED = "__comfyrizz_metadata_shim_wrapped__"


def install_metadata_shim(metadata: dict[str, str] | None = None) -> Callable[[], None]:
    """Force every ``ComfyClient.submit`` to send `metadata` (default: none), idempotently.

    Returns a restorer. Installing twice returns the first restorer's job rather than stacking a
    second wrapper — wrapping the wrapper is exactly the ``RecursionError`` from GPU test 2.
    """
    from .client import ComfyClient

    current = ComfyClient.submit
    if getattr(current, SHIM_MARKER, False):
        # already shimmed: never wrap a wrapper
        return getattr(current, _WRAPPED, lambda: None)

    original = current

    def submit(self, *args: Any, **kwargs: Any) -> Any:
        kwargs["metadata"] = metadata
        return original(self, *args, **kwargs)

    setattr(submit, SHIM_MARKER, True)

    def restore() -> None:
        if getattr(ComfyClient.submit, SHIM_MARKER, False):
            ComfyClient.submit = original

    setattr(submit, _WRAPPED, restore)
    ComfyClient.submit = submit
    return restore


def uninstall_metadata_shim() -> bool:
    """Restore the unpatched ``ComfyClient.submit``. True if a shim was in place."""
    from .client import ComfyClient

    current = ComfyClient.submit
    if not getattr(current, SHIM_MARKER, False):
        return False
    getattr(current, _WRAPPED, lambda: None)()
    return True

"""PB01: structured model-download failures before weight verification.

No Hugging Face, Google Colab, or GPU calls — synthetic stderr and fake results only.
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

os.environ["COMFYRIZZ_BOOTSTRAP_IMPORT_ONLY"] = "1"
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from bootstrap import (  # noqa: E402  — env must be set before import
    classify_download_stderr,
    require_successful_downloads,
)


class ClassifyDownloadTests(unittest.TestCase):
    def test_429_rate_limited_with_retry_after(self) -> None:
        info = classify_download_stderr(
            "Error: 429 Too Many Requests\nRetry-After: 12\nXet CDN throttled",
            1,
        )
        self.assertEqual(info["kind"], "rate_limited")
        self.assertEqual(info["status"], 429)
        self.assertEqual(info["retryAfterSeconds"], 12)
        self.assertEqual(info["returncode"], 1)

    def test_401_unauthorized(self) -> None:
        info = classify_download_stderr("401 Unauthorized: bad token", 1)
        self.assertEqual(info["kind"], "unauthorized")
        self.assertEqual(info["status"], 401)

    def test_403_forbidden(self) -> None:
        info = classify_download_stderr("403 Forbidden access denied", 1)
        self.assertEqual(info["kind"], "forbidden")
        self.assertEqual(info["status"], 403)

    def test_generic_nonzero(self) -> None:
        info = classify_download_stderr("connection reset by peer", 1)
        self.assertEqual(info["kind"], "download_failed")
        self.assertIsNone(info["status"])


class RequireSuccessfulDownloadsTests(unittest.TestCase):
    def test_all_ok_is_silent(self) -> None:
        require_successful_downloads(
            {
                "fasth3": {"repo": "org/fasth3", "revision": "abc", "files": 2, "rc": 0, "error": ""},
            }
        )

    def test_429_raises_structured_exit_before_hash(self) -> None:
        with self.assertRaises(SystemExit) as caught:
            require_successful_downloads(
                {
                    "fasth3": {
                        "repo": "org/fasth3",
                        "revision": "abc",
                        "files": 3,
                        "rc": 1,
                        "error": "429 Too Many Requests\nRetry-After: 30",
                    },
                    "ltx": {"repo": "org/ltx", "revision": "def", "files": 1, "rc": 0, "error": ""},
                }
            )
        payload = json.loads(str(caught.exception))
        self.assertEqual(payload["error"], "model_download_failed")
        self.assertEqual(len(payload["failures"]), 1)
        failure = payload["failures"][0]
        self.assertEqual(failure["host"], "fasth3")
        self.assertEqual(failure["repo"], "org/fasth3")
        self.assertEqual(failure["kind"], "rate_limited")
        self.assertEqual(failure["status"], 429)
        self.assertEqual(failure["retryAfterSeconds"], 30)
        # Must not look like a missing-file / hash path.
        blob = json.dumps(payload).lower()
        self.assertNotIn("filenotfound", blob)
        self.assertNotIn("hash mismatch", blob)

    def test_exhausted_style_failure_still_structured(self) -> None:
        with self.assertRaises(SystemExit) as caught:
            require_successful_downloads(
                {
                    "fasth3": {
                        "repo": "org/fasth3",
                        "revision": "abc",
                        "files": 1,
                        "rc": 1,
                        "error": "404 Not Found for revision",
                    },
                }
            )
        payload = json.loads(str(caught.exception))
        self.assertEqual(payload["failures"][0]["kind"], "not_found")
        self.assertEqual(payload["failures"][0]["status"], 404)


if __name__ == "__main__":
    unittest.main()

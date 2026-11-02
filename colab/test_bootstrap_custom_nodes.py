"""SPW11: install the lock's custom node packs before ComfyUI starts.

No git, pip, network or Google Colab calls: every command goes through a fake
``run`` that records the command line it was handed.
"""

from __future__ import annotations

import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

os.environ["COMFYRIZZ_BOOTSTRAP_IMPORT_ONLY"] = "1"
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from bootstrap import TORCH_REQUIREMENT_FILTER, install_custom_nodes  # noqa: E402


class FakeRun:
    """Records every command and returns scripted exit codes."""

    def __init__(self, codes: list[int] | None = None) -> None:
        self.calls: list[tuple[str, str]] = []
        self.codes = list(codes or [])

    def __call__(self, command: str, tag: str = "") -> int:
        self.calls.append((command, tag))
        return self.codes.pop(0) if self.codes else 0


def pack(name: str = "ComfyUI_Fill-ChatterBox", revision: str = "f7d7a161") -> dict:
    return {
        "name": name,
        "repo": f"https://github.com/filliptm/{name}.git",
        "revision": revision,
        "licence": "MIT",
    }


class NoCustomNodesTests(unittest.TestCase):
    def test_missing_list_makes_no_calls(self) -> None:
        fake = FakeRun()
        with tempfile.TemporaryDirectory() as tmp:
            installed = install_custom_nodes({}, Path(tmp) / "ComfyUI", fake)
        self.assertEqual(installed, {})
        self.assertEqual(fake.calls, [])

    def test_empty_list_makes_no_calls(self) -> None:
        fake = FakeRun()
        with tempfile.TemporaryDirectory() as tmp:
            installed = install_custom_nodes({"customNodes": []}, Path(tmp) / "ComfyUI", fake)
        self.assertEqual(installed, {})
        self.assertEqual(fake.calls, [])


class InstallCustomNodesTests(unittest.TestCase):
    def _comfy_with_requirements(self, tmp: str, node: dict, requirements: str) -> Path:
        comfy = Path(tmp) / "ComfyUI"
        target = comfy / "custom_nodes" / node["name"]
        target.mkdir(parents=True)
        (target / "requirements.txt").write_text(requirements, encoding="utf-8")
        return comfy

    def test_clone_checkout_and_filtered_pip(self) -> None:
        node = pack()
        fake = FakeRun()
        with tempfile.TemporaryDirectory() as tmp:
            comfy = self._comfy_with_requirements(tmp, node, "numpy\ntorch>=2\ntorchsde\n")
            target = comfy / "custom_nodes" / node["name"]
            installed = install_custom_nodes({"customNodes": [node]}, comfy, fake)

        self.assertEqual(installed, {node["name"]: node["revision"]})
        self.assertEqual(len(fake.calls), 4)

        clone, _ = fake.calls[0]
        self.assertIn("git clone", clone)
        self.assertIn(node["repo"], clone)
        self.assertIn(str(target), clone)

        checkout, _ = fake.calls[1]
        self.assertIn("checkout", checkout)
        self.assertIn(node["revision"], checkout)
        self.assertIn(str(target), checkout)

        requirements_list, _ = fake.calls[2]
        self.assertIn("grep -viE", requirements_list)
        self.assertIn(TORCH_REQUIREMENT_FILTER, requirements_list)
        self.assertIn("requirements.txt", requirements_list)

        pip, _ = fake.calls[3]
        self.assertIn("pip install", pip)
        self.assertIn("-r", pip)
        self.assertIn(node["name"], pip)

    def test_no_requirements_file_skips_pip(self) -> None:
        node = pack()
        fake = FakeRun()
        with tempfile.TemporaryDirectory() as tmp:
            comfy = Path(tmp) / "ComfyUI"
            (comfy / "custom_nodes" / node["name"]).mkdir(parents=True)
            installed = install_custom_nodes({"customNodes": [node]}, comfy, fake)

        self.assertEqual(installed, {node["name"]: node["revision"]})
        self.assertEqual(len(fake.calls), 2)
        self.assertNotIn("pip install", " ".join(command for command, _ in fake.calls))

    def test_each_pack_in_lock_order(self) -> None:
        first = pack("FirstPack", "aaa111")
        second = pack("SecondPack", "bbb222")
        fake = FakeRun()
        with tempfile.TemporaryDirectory() as tmp:
            comfy = Path(tmp) / "ComfyUI"
            for node in (first, second):
                (comfy / "custom_nodes" / node["name"]).mkdir(parents=True)
            installed = install_custom_nodes({"customNodes": [first, second]}, comfy, fake)

        self.assertEqual(installed, {"FirstPack": "aaa111", "SecondPack": "bbb222"})
        self.assertEqual(len(fake.calls), 4)
        self.assertIn(first["repo"], fake.calls[0][0])
        self.assertIn(second["repo"], fake.calls[2][0])

    def test_clone_failure_stops_before_checkout(self) -> None:
        fake = FakeRun([1])
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(SystemExit):
                install_custom_nodes({"customNodes": [pack()]}, Path(tmp) / "ComfyUI", fake)
        self.assertEqual(len(fake.calls), 1)
        self.assertIn("git clone", fake.calls[0][0])

    def test_checkout_failure_stops_before_pip(self) -> None:
        node = pack()
        fake = FakeRun([0, 1])
        with tempfile.TemporaryDirectory() as tmp:
            comfy = self._comfy_with_requirements(tmp, node, "numpy\n")
            with self.assertRaises(SystemExit):
                install_custom_nodes({"customNodes": [node]}, comfy, fake)
        self.assertEqual(len(fake.calls), 2)
        self.assertIn("checkout", fake.calls[1][0])

    def test_pip_failure_is_reported(self) -> None:
        node = pack()
        fake = FakeRun([0, 0, 0, 1])
        with tempfile.TemporaryDirectory() as tmp:
            comfy = self._comfy_with_requirements(tmp, node, "numpy\n")
            with self.assertRaises(SystemExit) as caught:
                install_custom_nodes({"customNodes": [node]}, comfy, fake)
        self.assertIn(node["name"], str(caught.exception))
        self.assertEqual(len(fake.calls), 4)


class TorchFilterTests(unittest.TestCase):
    def test_only_the_three_torch_distributions_are_dropped(self) -> None:
        pattern = re.compile(TORCH_REQUIREMENT_FILTER, re.IGNORECASE | re.MULTILINE)
        lines = [
            "torch>=2.4",
            "torchvision==0.19",
            "torchaudio",
            "torch==2.4.0+cu121",
            "torchsde",
            "torchmetrics>=1.0",
            "numpy",
        ]
        kept = [line for line in lines if not pattern.match(line)]
        self.assertEqual(kept, ["torchsde", "torchmetrics>=1.0", "numpy"])


if __name__ == "__main__":
    unittest.main()

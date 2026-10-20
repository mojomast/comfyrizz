"""Create the Google Colab render directories before the host uploads the bundle.

`colab upload` does not create parent directories. This cell only makes the
render work and cache directories. It does not read tokens or accept `--env`.
"""

from pathlib import Path

for path in (
    Path("/content/comfyrizz/render/out"),
    Path("/content/comfyrizz/render-cache/npm"),
    Path("/content/comfyrizz/render-cache/browser"),
    Path("/content/comfyrizz/render-cache/node"),
):
    path.mkdir(parents=True, exist_ok=True)

print("COMFYRIZZ_OK render-dirs", flush=True)

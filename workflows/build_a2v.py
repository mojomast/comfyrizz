"""Build the LTX-2.5 audio-to-video graph the presenter is made with (H17, research section 2.2).

The presenter is LTX-2.5 a2v: the narration WAV is encoded into the audio half of an AV latent and
*frozen*, and the video half is generated to match it. The graph is the plate graph we already run
(`ltx25_i2v_2stage.api.json`) with one node swapped:

    stage 1's video latent -> LTXVConcatAVLatent( video_latent, audio_latent )
                            ^                                   ^
                            LTXVImgToVideoInplace                 LTXVEmptyLatentAudio   (plates)
                                                                  LTXVAudioVAEEncode     (a2v, this graph)

Everything else - the dual-CFG guider with its audio_cfg, the separate step, the second concat that
already takes the *encoded* audio latent from stage 1 - is what the plate graph does. Deriving it
means a change to the LTX graph comes along instead of a second hand-written graph drifting from it.

The node signatures here are the ones the server itself published (the object_info captured during GPU
test 1): LTXVAudioVAEEncode takes `audio` and `audio_vae` and returns an audio latent, LoadAudio takes
the uploaded file's name, and the audio VAE is the second VAELoader the plate graph already loads.

Run from the repo root: `python3 workflows/build_a2v.py`.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "ltx25_i2v_2stage.api.json"
SOURCE_PARAMS = ROOT / "ltx25_i2v_2stage.api.params.json"
OUT_GRAPH = ROOT / "ltx25_a2v_2stage.api.json"
OUT_PARAMS = ROOT / "ltx25_a2v_2stage.api.params.json"

#: Where the narration file name travels: a LoadAudio node, and the runner uploads it like an image.
LOAD_AUDIO_ID = "44"
AUDIO_ENCODE_ID = "45"

#: The audio VAE the plate graph already loads (the second VAELoader).
AUDIO_VAE_NODE = "4"

#: The empty-audio node this graph replaces, and the concat that used it.
EMPTY_AUDIO_ID = "9"
STAGE1_CONCAT_ID = "10"


def main() -> int:
    graph = json.loads(SOURCE.read_text(encoding="utf-8"))
    params = json.loads(SOURCE_PARAMS.read_text(encoding="utf-8"))

    empty = graph.pop(EMPTY_AUDIO_ID, None)
    if empty is None or empty.get("class_type") != "LTXVEmptyLatentAudio":
        raise SystemExit(f"{SOURCE.name} has no {EMPTY_AUDIO_ID} LTXVEmptyLatentAudio to replace")
    vae_node = empty["inputs"]["audio_vae"][0]

    graph[LOAD_AUDIO_ID] = {"class_type": "LoadAudio", "inputs": {"audio": "narration.wav"}}
    graph[AUDIO_ENCODE_ID] = {
        "class_type": "LTXVAudioVAEEncode",
        "inputs": {"audio": [LOAD_AUDIO_ID, 0], "audio_vae": [vae_node, 0]},
    }
    # stage 1's concat now takes the encoded narration instead of an empty audio latent
    graph[STAGE1_CONCAT_ID]["inputs"]["audio_latent"] = [AUDIO_ENCODE_ID, 0]

    mapping = dict(params["map"])
    # the plate graph's `frames` maps to the empty-audio node's own length as well; that node is gone
    # here (the length now comes from the narration), so the mapping drops it rather than pointing at
    # a node this graph does not have - the contract test checks every target exists
    def without_removed(entries):
        rows = entries if isinstance(entries, list) and entries and isinstance(entries[0], list) else [entries]
        kept = [row for row in rows if str(row[0]) != EMPTY_AUDIO_ID]
        return kept[0] if len(kept) == 1 and not isinstance(entries[0], list) else kept

    for key, entries in list(mapping.items()):
        mapping[key] = without_removed(entries)
    mapping["audio"] = [LOAD_AUDIO_ID, "audio"]
    params["map"] = mapping
    params["generator"] = "ltx25-a2v"
    params["note"] = (
        "Derived from ltx25_i2v_2stage by workflows/build_a2v.py: stage 1's empty audio latent is "
        "replaced by the encoded narration (LTXVAudioVAEEncode), which the graph then freezes as the "
        "audio half of the AV latent. `audio` is the uploaded WAV's name; the narration is timed and "
        "padded host-side (research 2.2), so there are no start/duration params here. The video length "
        "still comes from `frames`, and it has to match what the audio encodes to."
    )

    OUT_GRAPH.write_text(json.dumps(graph, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    OUT_PARAMS.write_text(json.dumps(params, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{OUT_GRAPH.name}: {len(graph)} nodes (audio from {LOAD_AUDIO_ID} -> {AUDIO_ENCODE_ID}, audio VAE {vae_node})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

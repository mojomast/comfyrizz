"""Align and transcribe existing Qwen narration in the separate qwen-asr environment.

qwen-tts 0.1.1 and qwen-asr 0.0.6 pin different Transformers versions. Keeping
their environments separate avoids overriding either package's dependency contract.
"""
import argparse
import json
from pathlib import Path

import soundfile as sf

from narrate_qwen import build_chunks, spoken_for_scene
from qwen import Qwen3Aligner, Qwen3Asr, qwen_language_name, ALIGNER_MODEL
from qa import wer, should_regenerate
from synth import split_sentences


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    pkg = json.loads(args.package.read_text())
    path = args.out / "durations.json"
    report = json.loads(path.read_text())
    assert report["engine"] == "qwen3-tts", "QA requires Qwen narration"
    aligner, asr = Qwen3Aligner(), Qwen3Asr()
    language = qwen_language_name(pkg["voice"])
    scenes = [s for s in pkg["scenes"] if s["id"] in report["scenes"]]
    for index, scene in enumerate(scenes):
        print(json.dumps({"event": "alignment_scene_start", "sceneId": scene["id"], "completed": index, "total": len(scenes)}), flush=True)
        if scene["id"] not in report["scenes"]:
            continue
        measured = report["scenes"][scene["id"]]
        samples, sr = sf.read(args.out.parent / measured["file"], dtype="float32")
        pad = round(measured["paddingSeconds"] * sr)
        speech = samples[:-pad] if pad else samples
        sentences = split_sentences(scene["narration"])
        spoken, spoken_sentences = spoken_for_scene(scene, sentences)
        transcript = asr.transcribe(speech, sr, language)
        tokens = aligner.align(speech, sr, " ".join(sentences), language)
        measured["alignmentTokens"] = tokens
        measured["chunks"] = build_chunks(sentences, spoken_sentences, len(speech) / sr, tokens)
        measured["qa"] = {"transcript": transcript, "wer": round(wer(spoken, transcript), 4), "flagged": should_regenerate(spoken, transcript), "attempts": 1, "method": "separate-environment-qwen-asr"}
        print(scene["id"], json.dumps(measured["qa"]), flush=True)
        path.write_text(json.dumps(report, indent=2))
        print(json.dumps({"event": "alignment_scene_done", "sceneId": scene["id"], "completed": index + 1, "total": len(scenes), "flagged": measured["qa"]["flagged"]}), flush=True)
    timings = {c["timing"] for s in report["scenes"].values() for c in s["chunks"]}
    report["aligner"] = ALIGNER_MODEL if timings == {"aligner"} else "mixed" if "aligner" in timings else "syllable-fallback"
    path.write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()

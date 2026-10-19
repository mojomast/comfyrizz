"""Optional SyncNet QA for a single, locked-camera presenter and its exact voice.

Install SyncNet and its evaluation weights separately; --syncnet-dir points at
that checkout. Nothing is downloaded by this tool. Haar-detected, median-stable
face crops follow SyncNet's crop geometry, at 25 fps / 16 kHz. This is a useful
offset/confidence diagnostic, not a guarantee of natural articulation.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import cv2
import numpy as np
import torch


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--syncnet-dir", type=Path, required=True)
    parser.add_argument("--max-offset-ms", type=float, default=80)
    parser.add_argument("--min-confidence", type=float, default=3)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(4)
    sys.path.insert(0, str(args.syncnet_dir.resolve()))
    from SyncNetInstance import SyncNetInstance
    ffmpeg = lambda argv: subprocess.run(["ffmpeg", "-y", "-v", "error", *map(str, argv)], check=True)
    normalized = args.out / "source25.mp4"
    ffmpeg(["-i", args.video, "-an", "-vf", "fps=25", "-c:v", "libx264", "-crf", "16", normalized])
    cap = cv2.VideoCapture(str(normalized))
    detector = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    boxes, frames = [], []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frames.append(frame)
        if len(frames) % 5 == 1:
            candidates = detector.detectMultiScale(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), scaleFactor=1.1, minNeighbors=5, minSize=(64, 64))
            if len(candidates):
                boxes.append(max(candidates, key=lambda b: b[2] * b[3]))
    cap.release()
    if len(boxes) < 3:
        raise RuntimeError("Not enough face detections for a trustworthy sync diagnostic")
    x, y, w, h = np.median(boxes, axis=0)
    bs, cx, cy = max(w, h) / 2, x + w / 2, y + h / 2
    pad = int(bs * 1.8)
    cropfile = args.out / "face-silent.avi"
    writer = cv2.VideoWriter(str(cropfile), cv2.VideoWriter_fourcc(*"MJPG"), 25, (224, 224))
    for frame in frames:
        padded = np.pad(frame, ((pad, pad), (pad, pad), (0, 0)), constant_values=110)
        face = padded[int(cy+pad-bs):int(cy+pad+bs*1.8), int(cx+pad-bs*1.4):int(cx+pad+bs*1.4)]
        writer.write(cv2.resize(face, (224, 224)))
    writer.release()
    paired = args.out / "face-audio.avi"
    ffmpeg(["-i", cropfile, "-i", args.audio, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "pcm_s16le", "-ar", "16000", "-ac", "1", "-shortest", paired])
    model = SyncNetInstance(device="cpu")
    model.loadParameters(str(args.syncnet_dir / "syncnet_v2.model"))
    options = SimpleNamespace(tmp_dir=str(args.out / "frames"), reference="clip", batch_size=8, vshift=15)
    with torch.inference_mode():
        offset, confidence, distances = model.evaluate(options, str(paired))
    offset_ms = int(offset) * 40
    report = {
        "method": "SyncNet; static median Haar face crop; 25 fps; original narration resampled to 16 kHz",
        "video": str(args.video), "audio": str(args.audio), "offsetFrames25fps": int(offset), "offsetMs": offset_ms,
        "confidence": float(confidence), "minimumMeanDistance": float(distances.mean(axis=0).min()),
        "faceDetections": len(boxes), "faceBox": [float(n) for n in (x,y,w,h)],
        "passed": abs(offset_ms) <= args.max_offset_ms and float(confidence) >= args.min_confidence,
        "limits": {"maxOffsetMs": args.max_offset_ms, "minConfidence": args.min_confidence},
        "note": "Offset/confidence are diagnostics, not proof of phoneme accuracy or naturalness. Review paired playback too.",
    }
    (args.out / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    return 0 if report["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())

"""Opening/action/end samples and pixel-change measurements for each final scene."""
import argparse
import json
from pathlib import Path
import subprocess

import numpy as np
from PIL import Image, ImageDraw, ImageFont

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--run", required=True, type=Path)
parser.add_argument("--out", required=True, type=Path)
args = parser.parse_args()
args.out.mkdir(parents=True, exist_ok=True)
timeline = json.loads((args.run / "work/timeline.json").read_text())
pkg = json.loads((args.run / "work/package.json").read_text())
fps = timeline["fps"]
font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 16)
report = []
for scene in timeline["scenes"]:
    source = next(s for s in pkg["scenes"] if s["id"] == scene["id"])
    start, length = scene["from"] / fps, scene["durationInFrames"] / fps
    times = [start + .15, start + length * .5, start + length - .15]
    sheet = Image.new("RGB", (1440, 308), "#102c2d")
    draw = ImageDraw.Draw(sheet)
    pixels = []
    for index, seconds in enumerate(times):
        raw = subprocess.check_output(["ffmpeg", "-v", "error", "-ss", str(seconds), "-i", str(args.run / "video.mp4"), "-frames:v", "1", "-vf", "scale=480:270", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"])
        image = Image.frombytes("RGB", (480, 270), raw)
        sheet.paste(image, (480 * index, 0))
        draw.text((480 * index + 8, 280), f"{scene['id']} / {seconds:.2f}s", fill="white", font=font)
        # Exclude the lower caption band from movement measurement.
        pixels.append(np.array(image)[:210].astype(float))
    sheet.save(args.out / f"{scene['id']}.jpg", quality=93)
    changes = [float(abs(a-b).mean()) for a, b in zip(pixels, pixels[1:])]
    report.append({"scene": scene["id"], "seconds": length, "sampleTimes": times,
                   "meanAbsolutePixelChange": changes, "intentionalGraphicHold": pkg["assets"][source["background"].get("asset") or source["foreground"][0]["asset"]]["kind"] == "svg"})
(args.out / "temporal-metrics.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({"scenes": len(report), "samples": len(report) * 3, "directory": str(args.out)}))

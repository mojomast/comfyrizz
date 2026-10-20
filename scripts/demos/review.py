"""Extract labelled scene midpoints for human review of a completed demo."""
import argparse
import json
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    timeline = json.loads((args.run / "work/timeline.json").read_text())
    package = json.loads((args.run / "work/package.json").read_text())
    scenes = {scene["id"]: scene for scene in package["scenes"]}
    args.out.mkdir(parents=True, exist_ok=True)
    width, height, label_height, columns = 480, 270, 42, 3
    rows = (len(timeline["scenes"]) + columns - 1) // columns
    sheet = Image.new("RGB", (columns * width, rows * (height + label_height)), "#101922")
    draw = ImageDraw.Draw(sheet)
    font_path = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
    font = ImageFont.truetype(str(font_path), 14) if font_path.exists() else ImageFont.load_default()
    for index, scene in enumerate(timeline["scenes"]):
        seconds = (scene["from"] + scene["durationInFrames"] * .5) / timeline["fps"]
        frame = args.out / f"{index + 1:02d}-{scene['id']}.png"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(seconds), "-i", str(args.run / "video.mp4"), "-frames:v", "1", "-vf", f"scale={width}:{height}", str(frame)], check=True)
        x, y = (index % columns) * width, (index // columns) * (height + label_height)
        with Image.open(frame) as image:
            sheet.paste(image.convert("RGB"), (x, y))
        source = scenes[scene["id"]]
        title = source.get("copy", {}).get("headline", scene["id"])
        recipe = source.get("motion", {}).get("recipe", "layout motion")
        draw.text((x + 10, y + height + 4), f"{index + 1:02d}  {title[:52]}", font=font, fill="#f3eee3")
        draw.text((x + 10, y + height + 23), f"{seconds:.1f}s · {source['layout']} · {recipe}", font=font, fill="#b9c7ce")
    target = args.out / "contact-sheet.jpg"
    sheet.save(target, quality=92)
    print(json.dumps({"scenes": len(timeline["scenes"]), "contactSheet": str(target)}))


if __name__ == "__main__":
    main()

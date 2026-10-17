"""Contact sheets for GPU test 2 (box CPU, Pillow)."""
import glob, os, sys
from PIL import Image, ImageDraw, ImageFont
R = "/workspace/comfy-hackathon/test/gpu2"; RAW = f"{R}/raw"; OUT = f"{R}/contact"
try: F = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 18)
except Exception: F = ImageFont.load_default()
def sheet(files, labels, out, cols, th=270):
    ims = [Image.open(f).convert("RGB") for f in files]
    ims = [i.resize((int(i.width * th / i.height), th)) for i in ims]
    cw = max(i.width for i in ims); rows = (len(ims) + cols - 1) // cols
    c = Image.new("RGB", (cols * cw + (cols + 1) * 8, rows * (th + 30) + 8), (24, 24, 28)); d = ImageDraw.Draw(c)
    for k, (im, lb) in enumerate(zip(ims, labels)):
        x = 8 + (k % cols) * (cw + 8); y = 8 + (k // cols) * (th + 30)
        c.paste(im, (x + (cw - im.width) // 2, y)); d.text((x, y + th + 4), lb, fill=(230, 230, 235), font=F)
    c.save(out, quality=90); print(out, c.size)
first = lambda p: sorted(glob.glob(f"{RAW}/{p}*.png"))[-1]
from prompts import STYLES, SVGS, SVG_STYLES
sheet([first(f"st_{s[0]}_") for s in STYLES], [s[0] for s in STYLES], f"{OUT}/klein_styles.jpg", 6, 220)
for s in SVGS:
    files, labels = [f"{R}/inputs/{s}.png"], ["input SVG"]
    for t in SVG_STYLES:
        for v in ("d45", "d60", "d75", "ref"):
            files.append(first(f"svg_{s}_{t}_{v}_")); labels.append(f"{t} {v}")
    # layout: input + 12 -> 13 tiles; cols 4 with input first row
    sheet(files, labels, f"{OUT}/svg_{s}.jpg", 4, 200)
for sc in ("background", "hero", "texture"):
    fs = sorted(glob.glob(f"{RAW}/e2_sample_{sc}_*.png")); fs = [f"{R}/inputs/e2_sample_{sc}.png"] + fs
    sheet(fs, ["input raster"] + [os.path.basename(f).replace(f"e2_sample_{sc}_", "").replace("_00001_.png", "") for f in fs[1:]], f"{OUT}/e2_{sc}.jpg", 5, 160)

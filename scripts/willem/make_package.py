"""Build examples/willem-birthday/package.json (comfyrizz.package/v1) from the GPU clips in
/workspace/willem-birthday/clips (v_<scene>.mp4). Media is copied into examples/willem-birthday/assets/
(gitignored: private family content stays off git). media.json is the sidecar read by scripts/willem/explainer."""
import json, hashlib, os, shutil, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__)); REPO = os.path.abspath(f"{HERE}/../..")
EX = f"{REPO}/examples/willem-birthday"; W = "/workspace/willem-birthday"
sys.path.insert(0, HERE); import prompts as P
os.makedirs(f"{EX}/assets", exist_ok=True)
SC = {s[0]: s for s in P.SCENES}
def sha(p): return hashlib.sha256(open(p, "rb").read()).hexdigest()
def probe(p):
    o = json.loads(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height,nb_frames", "-show_entries", "format=duration", "-of", "json", p], capture_output=True, text=True).stdout)
    s = o["streams"][0]; return dict(width=s["width"], height=s["height"], fps=24, frames=int(s["nb_frames"]), durationSeconds=round(float(o["format"]["duration"]), 3), audio="none")
assets = {}
for sid in SC:
    src = f"{W}/clips/v_{sid}.mp4"
    if not os.path.exists(src): continue
    aid = f"a_{sid}"; dst = f"{EX}/assets/{aid}.mp4"; shutil.copy(src, dst)
    assets[aid] = {"kind": "video", "origin": "generated", "status": "ready", "file": f"assets/{aid}.mp4", "sha256": sha(dst), "bytes": os.path.getsize(dst),
                   "media": probe(dst), "license": {"id": "LicenseRef-private-family"}, "redistributable": False,
                   "model_license": {"id": "LicenseRef-LTX-2.5", "url": "https://huggingface.co/Lightricks/LTX-2.5", "note": "LTX-2.5 i2v from a FLUX 3 Klein reference-edit still."},
                   "gen": {"generator": "ltx25", "model": "ltx-2.5-22b-distilled", "quantization": "int8", "caption": SC[sid][2]},
                   "notes": "Private family video (comfyrizz-willem, Oct 17 2026). Reference photo and media are not committed."}
FADE = {"type": "fade", "frames": 12}
BG = lambda aid: {"asset": aid, "fit": "cover", "loop": True, "muted": True}
scenes = [{"id": "s_title", "layout": "title", "variant": "centered", "preferredFrames": 165,
           "copy": {"kicker": "17 octobre 2026", "headline": "Willem a 3 ans !", "sub": "Une journée super extraordinaire"},
           "background": BG("a_portrait"), "transitionOut": FADE,
           "narration": "Aujourd'hui, Willem a trois ans ! Et à trois ans, on peut tout faire !"}]
for sid in ["rocket", "surf", "racecar", "dj", "dragon", "soccer", "orchestra", "cake"]:
    _, _, _, line, narr = SC[sid]
    scenes.append({"id": f"s_{sid}", "layout": "hero", "variant": "full-bleed", "preferredFrames": 165 if sid != "cake" else 330,
                   "copy": {"headline": line[:64]}, "background": BG(f"a_{sid}"), "transitionOut": FADE, "narration": narr})
scenes[-1].pop("transitionOut")
pkg = {"$schema": "https://comfyrizz.example/schema/package-v1.json", "schemaVersion": 1, "revision": 1, "id": "pkg_willem3", "title": "Joyeux 3e anniversaire, Willem !",
       "createdAt": "2026-10-17T15:00:00.000Z", "format": {"width": 1920, "height": 1080, "fps": 30}, "duration": {"mode": "flexible", "flexibleCeilingFrames": 2700},
       "theme": {"palette": ["#2b1640", "#ff7a59", "#ffd166", "#fff8f0"], "font": "Inter"},
       "voice": {"enabled": True, "engine": "kokoro", "voice": "ff_siwis", "speed": 1, "language": "fr-fr"},
       "scenes": scenes, "assets": assets,
       "compliance": {"open_weights_only": True, "llm": {"provider": "local-agent", "model": "hand-written", "weights": "open"}, "backends_used": ["colab:G4"], "closed_apis_used": [],
                      "warnings": ["Private family video: the reference photo and all generated media stay out of git.", "Stills: FLUX 3 Klein reference edit (BF16); motion: LTX-2.5 i2v (int8) on Google Colab G4."]}}
json.dump(pkg, open(f"{EX}/package.json", "w"), indent=2, ensure_ascii=False)
lt = {f"s_{sid}": {"kicker": "Willem,", "text": SC[sid][3]} for sid in ["rocket", "surf", "racecar", "dj", "dragon", "soccer", "orchestra"]}
media = {"note": "Sidecar for scripts/willem/explainer.", "scrim": {},
         "skipLayout": [s["id"] for s in scenes], "lowerThird": lt,
         "bigTitle": {"s_title": {"kicker": "17 octobre 2026", "text": "Willem a 3 ans !", "sub": "Une journée super extraordinaire", "position": "bottom", "confetti": False},
                      "s_cake": {"text": "Joyeux 3e anniversaire, Willem !", "sub": "Gros bisous de ton parrain Kyle"}},
         "music": {"file": "music.wav", "fromScene": "s_cake", "volume": 0.35}}
json.dump(media, open(f"{EX}/media.json", "w"), indent=2, ensure_ascii=False)
open(f"{EX}/.gitignore", "w").write("assets/\npublic/\nout/\naudio/\n*.mp4\n*.wav\n*.png\n*.jpg\n")
print("ok", len(assets), "assets")

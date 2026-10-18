# Credits — `examples/hook-20s`

The 20 second launch-video hook used to open the submission video (spec 11,
beat 1). It is a self-contained Comfyrizz package: 1920×1080, 30 fps, four
procedural scenes, Kokoro narration and sentence-level captions. It renders on
CPU with no GPU media and no network access at run time.

## Composition

| Scene      | Layout            | Content                                        |
| ---------- | ----------------- | ---------------------------------------------- |
| `s_title`  | `title/centered`  | Kicker, headline and the Comfyrizz sub-line    |
| `s_chart`  | `chart/bar`       | Bar chart of the minutes from brief to export  |
| `s_list`   | `list/bullets`    | "No GPU. No cloud. No network." + three points |
| `s_outro`  | `title/outro`     | "Comfyrizz" + "Open source, MIT." closing card |

Backgrounds are procedural (mesh, grid, dots) drawn by the renderer from the
theme palette. The check mark, flow diagram and animated bars are first-party
SVG / keyframed-vector assets under `assets/`.

## Assets and licences

- **SVG and vector-animation assets** (`assets/*.svg`) are first-party artwork
  authored for the Comfyrizz examples and released under **CC0-1.0**. Each asset
  carries its measured `sha256`, byte size and a CPU render-check in
  `package.json`.
- **Narration** (`audio/narration.norm.wav`) is synthesized locally on CPU by
  **Kokoro-82M** (`kokoro-v1.0.onnx`, voice `af_heart`, speed 1.05) via the
  `kokoro-onnx` wrapper. Kokoro-82M weights are **Apache-2.0**
  (<https://huggingface.co/hexgrad/Kokoro-82M>). The wrapper, voice pack and
  phonemizer notices are in `packages/tts/README.md`.
- **Captions** (`captions.srt`, `captions.vtt`) are exported from the same
  measured cues the player burns in; they are not transcribed separately.

## Data

The chart dataset `d_times` is invented example data for the hook. It is marked
`source: example`, `approved: true` and labelled on the chart. No third-party
data, stock footage or stock imagery is used.

## Reproduce

```sh
# 1. Synthesize the narration (needs the local Kokoro cache, no network at run time).
python packages/tts/py/synth.py \
  --package examples/hook-20s/package.json \
  --out examples/hook-20s/audio \
  --model-dir ~/.cache/comfyrizz/kokoro

# 2. Mix, loudness-normalise and compile the committed timeline + captions.
node packages/tts/scripts/narrate.mjs --example examples/hook-20s
node apps/renderer/scripts/recompile-example-timeline.mjs --example examples/hook-20s

# 3. Export the MP4 on CPU (h264 + aac, 1920×1080, frames == the timeline).
node apps/renderer/scripts/render-package-example.mjs --example examples/hook-20s
```

The MP4 lives in `out/` and is intentionally not committed, like the other
examples.

## License

The package itself is part of Comfyrizz and follows the repository's **MIT**
license. Nothing in this example requires a Google Colab runtime.

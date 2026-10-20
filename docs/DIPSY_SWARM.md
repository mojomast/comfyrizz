# Dipsy and the Thousand Little Helpers

An original science-fiction adventure: when Luma's planetary shield breaks,
Dipsy uses DeepSeek to split the rescue into scout, builder and courier tasks.
A storm forces the agents to share new observations and find another route.
Dipsy stays involved, tests a small repair and completes the final connection.

## Direction

- **21 scenes:** 18 generated motion sequences and three native HyperFrames inserts.
- **4,011 frames at 30 fps:** 133.7 seconds, with motion sequences occupying 86.1%
  of the measured timeline.
- A recurring lime-green mechanic with a copper helmet, orange scarf and blue
  backpack; amber rescue drones with cyan lenses; violet cliffs and turquoise rivers.
- Original Kokoro narration, phrase-grouped captions and a locally synthesized
  adventure score with a recurring motif, storm pulse and quiet final connection.
- DeepSeek appears as Dipsy's fictional planning assistant. The story is fiction.

The inserts are the rescue-team plan (`s_06`), the revised route (`s_14`) and the
completed connection (`s_18`). Their cues use estimated words within measured
sentence narration; they are not forced-alignment timestamps.

## Reproduce the source

Keep the project directory outside the repository. These commands author and time
the project; GPU allocation is a separate production operation.

```bash
node scripts/demos/dipsy.mjs build /absolute/external/dipsy-project
.venv/bin/python packages/tts/py/synth.py \
  --package /absolute/external/dipsy-project/package.json \
  --out /absolute/external/dipsy-project/audio --padding 0.5
node scripts/demos/dipsy.mjs time /absolute/external/dipsy-project
.venv/bin/python scripts/demos/dipsy-score.py /absolute/external/dipsy-project
node scripts/compositions/build.mjs /absolute/external/dipsy-project --check
```

The source includes all prompts, seeds, workflow identities, narration, character
direction, storyboard and composition manifests. Timing adjusts each generated
clip's requested length to cover its scene without looping. GPU generation needs
18 Klein stills and 18 LTX-2.5 image-to-video jobs.

Use the normal production pipeline with `backendId: 'colab'` and
`renderLocation: 'colab'` to hold the media VM for the final render. The
[source-only Colab bootstrap](COMPOSITIONS.md#google-colab-remote-render) installs
HyperFrames and builds the scene resources there. The requested remote location
must be confirmed in the completed result; local fallback is not a passing live
Colab build test.

## Production evidence

The working campaign is retained externally under
`~/comfyrizz-gpu-tests/dipsy-swarm-20261020/`. Source validation, measured narration,
score synthesis and compilation of all three composition manifests passed.
Two live GPU runs were rejected for unavailable G4 capacity after six allocation
requests in total; no GPU session was allocated and no credits were charged.
The retry correctly retained the capacity error after fixing a pipeline cleanup
path that had mislabeled rejected allocations as unconfirmed shutdowns.
Final rendering and publication are not yet verified.

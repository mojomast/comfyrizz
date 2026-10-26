# Easy UX

Easy UX is the wave that keeps Super Easy short and makes every way out of it predictable. This note records the approved defaults (plan §5), the lip-sync wording rule, and the escape paths between Super Easy, Easy Studio and the editor. It does not replace the UI vocabulary in [README.md](README.md).

## Wave defaults

| Id | Default | What it means |
| --- | --- | --- |
| D1 | Wave EX on `feat/easy-ux` | The wave integrates on `feat/easy-ux`, branched from `main` at `f98c75d`, and carries the EASY-UX label. Main merges need the owner's OK; the wave never tags. |
| D2 | UI and unit tests first | Browser smoke tests run only where a task marks them. Tests use fakes and the CPU path; no test spends Google Colab units. |
| D3 | Cheap-first routing | UI copy and layout work prefers the lower-cost model; host-bound work uses the free default. |
| D4 | Done screen | A finished Super Easy video offers **Download** (primary), **Open in Studio** and **Make another**. **Open in editor** stays available as the secondary editor escape. |
| D5 | Studio escape | Leaving Super Easy for a package opens the step that package has actually reached, not always Idea. A bare **I want more control** visit with no package may still open Idea. |
| D6 | Reverse path | Easy Studio home offers a secondary **Make it simple** button that clears the sticky Studio choice and returns to Super Easy. **I want more control** still sets that choice. |
| D7 | Lip-sync wording | Easy copy explains an unavailable lip-sync check in plain words and never names the product behind it. The notice can be dismissed for the session. |
| D8 | Level label | The compact stepper says **Level**. The heading can stay friendlier: **How many versions should we try?** |
| D9 | Compute-aware Level intro | On **This computer**, the Level intro does not claim that more versions use more Google Colab units. |
| D10 | Idea defaults | Templates, length and shape stay visible. **Look** moves under **More options** so the default path stays close to five Tab stops to **Continue**. |
| D11 | Export after reload | If the exported revision is current but no video file is in memory, the Export step offers a working **Export again**, never a dead **Download**. |
| D12 | Editor bleed cleanup | Editor-only language and controls that leak into Easy are in scope, because **Open in editor** is an Easy escape. |
| D13 | Offline planner | Rewriting the offline planner is out of scope. The plain banner **Written from templates** stays. |
| D14 | Google Colab | Every mention says **Google Colab**, never the bare product name. |

## Done screen and escapes

### Finished video

**Download** is the only primary action. It uses the final video URL already in the progress view. If that URL is missing or unusable, Download is not drawn at all.

The other actions, in order, are:

1. **Open in Studio** keeps the package id and lands on the package's reachable step.
2. **Make another** clears the local Easy state and returns to the bare Super Easy landing. It does not delete the finished video from the library.
3. **Open in editor** is the secondary Advanced escape and keeps the same video.

### Derived Studio step

**Open in Studio** and **I want more control** keep the package, drop the editor view and derive the step from that package:

| Package state | Studio opens |
| --- | --- |
| Plan is missing, not approved or stale | Plan |
| Generation is running or stopping | Generate |
| Shots are not all kept, or the export is not current | Review |
| Generation is done, shots are kept and the export is current | Export |
| No package, or a new visit with no package | Idea |

A resumed package never falls back to Idea just because the local idea text is short.

### Make it simple

**Make it simple** is the reverse of **I want more control**:

- It clears only the sticky `preferStudio` preference.
- It leaves recent videos, the library and the server package untouched.
- It paints Super Easy immediately.
- **I want more control** still sets `preferStudio` and opens Easy Studio.

### Export after reload

The Export step restores a matching exported revision without starting a new render when the cached video file is still available. After a reload, a current revision may have no video file in memory. In that case the screen says the export is ready to repeat and offers **Export again**; it never presents a Download that cannot work.

## Lip-sync wording

Easy copy may explain that a lip-sync check is unavailable, but it never uses the product name **SyncNet**. The notice belongs to presenter projects, and to projects with a talking-head shot, when that check was skipped. Use plain language and point at the safe action:

> Lip-sync will not be checked on this setup. Keep a version of every talking shot before you export.

Rules:

- Do not put **SyncNet** in Easy buttons, headings, banners, errors, tests' visible strings or docs aimed at Easy users.
- Say **lip-sync check unavailable** or **lip-sync will not be checked**, then tell the user to keep a version of every talking shot before export.
- The banner is dismissible for the current session only. Dismissal is not stored as a permanent preference.
- Do not make the notice sound like a failed render. It is a check that did not run.

Internal module, code and API names may still use `syncnet`; only the words a user sees are constrained.

## Google Colab wording

- Always write **Google Colab** in full, in code, copy, tests and docs.
- **This computer** is the free local path. It does not spend Google Colab units.
- Google Colab spends Google Colab units, up to the video's spend cap. The user approves that spend; choosing **This computer** starts nothing on Google Colab.
- Keep **Google Colab** in settings labels and spend explanations as well as button labels.

// Structure of the machine-generated correction prompt. Live briefs, package
// dumps, and model text are never stored here.

export const CORRECTION_TEMPLATE_FOR_REPORT = `
PLANNING CORRECTION (one bounded edit; thinking enabled)
This prompt is machine-generated. It contains only the original brief, objective failure codes, relevant package context, immutable IDs, and the allowed-edit scope.
Do not start production, a run, a pipeline, or media generation.
Do not call storyboard.propose. If a global replan is required, stop without editing.

Original brief:
<original brief>

Objective failure codes/details:
- <CODE>: <detail> (scene=<id> asset=<id>)

Relevant package/scene/asset context:
- packageId, sceneCount, format
- per-scene layout/variant/frames/narration/cues/media/headline presence
- per-asset kind/generator/status

Immutable IDs (must preserve):
- package id
- unrelated scene ids
- unrelated asset ids

Explicit allowed-edit scope:
- only the listed failure codes
- named scene/asset ids when present
- preserve previously passing requirements
- preserve out-of-scope creative choices
- preserve package id and unrelated scene/asset ids
`;

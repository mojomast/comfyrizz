# Evaluating ComfyRizz UX changes against actual outcomes

Companion to [the current-code and best-practice audit](UX_RESULTS_AUDIT_20261026.md).
Proposed evaluation plan; these are not newly executed test results.

## Outcome measures

Measure success at the user-task level, not number of tool calls or jobs marked
complete. Record the tested build, starting fixture, provider/backend configuration,
viewport/input modality, actual observable result and unresolved limitations.

| Outcome | Measure | Avoid misleading proxy |
| --- | --- | --- |
| Clear first step | Time and errors from blank entry to an accurate reviewed plan | A visible Generate button alone |
| Appropriate creative control | User can explain what happens next and which inputs are approved | Counting approval dialogs |
| Voice/identity continuity | Selected reference hashes retained; human comparison of actual recordings/takes | Matching voice preset names or language tags |
| Efficient correction | Intended fields/artifacts changed; unrelated ones remain identical | Agent saying “changed only that shot” |
| Cost comprehension | User can identify total allowance, proposed exposure, spend and remaining funds | A single estimate without scope or unit |
| Recovery | Reload/disconnect/crash restores pending decision and actual job without duplicate work | Spinner eventually disappearing |
| Final correctness | Delivered video/captions/source revision agree and downloads verify | Existing `video.mp4` file |
| Accessibility | Journey completion by keyboard and narrow/touch layout; focus/error recovery | Initial-page automated accessibility score alone |
| Creative quality | Paired audible/full-motion human review using brief-specific criteria | Transcript accuracy or a pleasing still frame |

Do not assign invented numerical targets before collecting a baseline. Establish
baseline completion/error rates and durations with the same fixtures, then compare
changes. Report distributions and failure examples; avoid a single composite score
that hides data loss or unnecessary spending behind faster completion.

## Three complementary suites

### 1. Deterministic product regressions

Use isolated runtime copies, synthetic source pages, fixture audio/video and fake
providers/backends. Block external network and paid calls. Test mounted routes and
controls, including old paths, rather than relying only on injected controllers.

- Brand URL → sourced plan, with unsupported claims still uncertain.
- New project from a populated old one; no inherited identity by accident.
- Explicit voice selection, appearance-only revision, transfer test and next step.
- Unselected/rejected candidates cannot become default reference inputs.
- Duplicate click, dropped HTTP response and stale approval do not repeat effects.
- One-shot feedback, caption-only correction and music-only edit preserve sources.
- Reload while running or waiting for review; late events from another project.
- Revision conflict while generation completes; prior manual timing remains.
- Failed download after successful generation; recover bytes without inference.
- Final render/export gate and snapshot agree across every supported entry point.
- 390px mobile, keyboard-only operation, focus restoration and error-state access.

Use distinct labelled fixture media to verify actual decoded take identity. Never
inject missing product UI into the DOM to make acceptance assertions pass.

### 2. Task-based usability sessions

Recruit both new users and people returning to an existing project. Include
keyboard-only and narrow/touch use. Ask users to accomplish goals, not follow
button-by-button instructions that disclose the intended solution.

1. Create a short video about supplied material and explain what will be generated.
2. Change only the host's appearance, keeping the chosen voice.
3. Find the difference between two takes and choose one for the cut.
4. Correct a repeated phrase without changing neighboring scenes.
5. Resume interrupted work and identify what, if anything, will cost more.
6. Export and identify what is editable in the app versus in source files.

Capture misunderstandings, unintended clicks, abandonment, help requests, scope
errors, confidence and the final artifact. Ask neutral questions; do not turn
research into a guided demo. Keep consent and private project content appropriate
to the study; fixture projects suffice for initial sessions.

### 3. Authorized creative-quality trials

Only after deterministic paths pass, run separately authorized small real-media
trials. Compare conditions using the same brief/reference where practical and
retain all accepted/rejected samples. Evaluate voice personality, accent,
identity, physical action, mouth performance, pacing, claim fidelity, text
legibility, mix intelligibility and final comprehension. Include uncertain and
not-reviewed outcomes. The user's preferences guide their project; do not claim
they generalize to every audience or character.

## Release acceptance

Every prioritized fix has a before/after reproducer and an observable user result.
Ship small vertical improvements through actual entry points. A model prompt,
contract, backend service or card component alone is not a completed UX change.
Keep code-level passes, browser observations and subjective reviews separate in
the release report.

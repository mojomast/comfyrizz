# QA fixtures and acceptance baselines (UX20)

Independent, cross-system test infrastructure for the UX results remediation
plan (`docs/tasks/UX_RESULTS_REMEDIATION_20261026.md`). It adds new fixtures
and pre-fix failure harnesses only. Component tests stay owned by their packets.

Rules every file here follows:

- Fail closed. No outbound request leaves loopback: not to a model provider,
  not to Google Colab, not to the internet. An attempt throws and is logged.
- No secrets, no live service, no paid Google Colab or GPU work.
- Assert real behavior: the decoded identity of media, server state, DOM state.
  Never inject UI or patch product code to make an assertion pass.

## Layout

```
qa/lib/                      shared fixtures (Node, no dependencies)
  egress-guard.mjs           in-process fail-closed egress + scrubbedEnv()
  egress-preload.mjs         the same guard as `node --import` for spawned servers
  known-defect.mjs           knownDefect(): turn an audited failure into a labelled pass
  media-fixtures.mjs         labelled WAV / PNG / MP4 and their decoders
  scripted-provider.mjs      loopback OpenAI-compatible SSE model (real adapter, real tool loop)
  fake-runtime.mjs           counts pipeline/backend dispatch; Google Colab and BYO throw
  app-fixture.mjs            the real createApp over HTTP with all of the above
  chat-fixture.mjs           conversations, scoped chat turns, proposals
qa/tests/                    node:test suites (self-checks + pre-fix baselines)
apps/web/e2e/acceptance/     Playwright acceptance project (new, separate config)
```

## Commands

```bash
# Node fixtures, self-checks and baselines (no browser)
pnpm test:qa            # node --experimental-strip-types --test "qa/tests/*.test.mjs"

# Which Playwright engines launch on this host
pnpm -C apps/web test:acceptance:browsers

# Browser acceptance: real server + Vite, loopback only
pnpm -C apps/web exec playwright install chromium firefox webkit   # once
pnpm test:acceptance
QA_BROWSERS=webkit pnpm test:acceptance                 # filter projects by substring
QA_BROWSERS=chromium-desktop,firefox-desktop pnpm test:acceptance
```

Do not pass a directory to `node --test`; use the glob above.

`pnpm test` and `pnpm check` are unchanged. These suites are opt-in until the
owners of the Wave 1 packets decide to fold them in.

### Playwright projects

All are emulation. No real iOS device, Android phone or assistive technology is
involved.

| project | engine | viewport / device profile |
| --- | --- | --- |
| `chromium-desktop` | Chromium | 1280x800 |
| `firefox-desktop` | Firefox | 1280x800 |
| `webkit-desktop` | WebKit | 1280x800 (not Safari itself) |
| `chromium-390` | Chromium | Pixel 7 profile, 390x844, touch |
| `webkit-390` | WebKit | iPhone 13 profile, 390x844, touch |
| `firefox-390` | Firefox | desktop profile at a 390x844 viewport (no touch emulation) |
| `chromium-320` | Chromium | Pixel 7 profile, 320x640 |

Playwright's HTML/trace output goes to the OS temp dir
(`comfyrizz-acceptance-results`, `comfyrizz-acceptance-report`) because files
under the Vite root trigger dev-server reloads. The JSON report is
`apps/web/e2e/.output/acceptance-report.json` (gitignored).

## Pre-fix baselines and how packets use them

Each baseline has a CONTROL beside it that proves the harness can see the
guarded behavior working, so a baseline cannot "fail" only because the fixture
is broken.

| packet | where | what it reproduces today |
| --- | --- | --- |
| UX01 | `qa/tests/ux01-admission.baseline.test.mjs` | an active, paused or cancelled bound production still launches `/api/pipeline` (202, one launch) |
| UX09 | `qa/tests/ux09-scope.baseline.test.mjs` | viewer `iterationScope` not propagated; named ids refused; paused/unrelated ordinary-tool mutation |
| UX05 | `qa/tests/ux05-undo-save.baseline.test.mjs`, `apps/web/e2e/acceptance/ux05-undo-save.spec.ts` | edit, save, undo sends the stale CAS revision (browser: the undo is never saved) |
| UX06 | `apps/web/e2e/acceptance/ux06-first-result.spec.ts` | Super Easy CPU build ends on "Making your video 0%": no Review/Export handoff, no escape control |
| finding | `qa/tests/easy-steps-glob.baseline.test.mjs` | `easy/steps/index.ts` globs `*.test.ts` into the app (see Limitations) |

The Node baselines use `knownDefect(t, { packet, finding }, assertion)`. The
assertion states the required behavior. While the defect exists it fails with an
`AssertionError` and is reported as reproduced. Anything else (a TypeError, a
timeout) is rethrown as a harness bug. When the assertion starts passing the
wrapper fails with "defect looks fixed". The Playwright baselines use the same
idea through `knownDefect(packet, reason)` in `fixtures.ts`, which calls
`test.fail`.

Converting a baseline when your packet lands:

1. Run it unwrapped to see it pass: `QA_EXPECT_FIXED=UX05 pnpm test:qa` or
   `QA_EXPECT_FIXED=UX05 pnpm test:acceptance`. (`all`, or a comma list, also work.)
2. Delete the `knownDefect(...)` wrapper or call. The test is now an ordinary
   regression. Keep the CONTROL.
3. Add your packet's own cases next to it. Extend the helpers rather than copying them.

Verified now: `QA_EXPECT_FIXED=UX01` fails the 3 UX01 baselines, `UX09` fails 4,
`UX05` fails 1 (node), and `all` fails 9 Node baselines. Unwrapped, the browser
UX05 and UX06 baselines fail for the audited reason (the undo is not saved; no
handoff or escape control appears).

## Helpers for later packets

`apps/web/e2e/acceptance/helpers/` plus `patterns.spec.ts`. Each has a working
self-check and `test.fixme` entries naming the packet that owns the real assertion.

| pattern | helper | extended by |
| --- | --- | --- |
| keyboard and focus | `focus.ts`: `describeFocus`, `tabThrough` (reports obscured focus) | UX12, UX13, UX19 |
| media ticket expiry | `tickets.ts`: `expireMediaAfter` (serves N, then 410 until renewed) | UX11, UX12 |
| late and replayed events | `events.ts`: `serveEventStream` scripted SSE | UX04, UX07 |
| mobile reflow | `reflow.ts`: `reflowReport` (horizontal overflow, off-screen controls) | UX19, UX16 |
| reload | real `page.reload()` in `patterns.spec.ts` | UX05, UX07, UX16 |
| media identity | `media.ts`: `decodedAudioId`, `decodedImageId`, `decodedVideoFrameId` | UX11, UX12, UX13 |

Labelled media: every fixture carries a 16-bit identity derived from its label.
Audio is an 8 kHz FSK WAV that decodes with a Goertzel detector and survives
seeking; pictures carry black/white cells that decode at any scale; video is an
H.264/AAC MP4 made with local ffmpeg. Decoders also run on samples and pixels
the browser itself decoded, so a test proves which take a player really loaded.

## Limitations

- WebKit on Linux needs the GStreamer plugin packages
  (`gstreamer1.0-plugins-good`, `-base`, `-libav`) to decode WAV and H.264. On
  this host they were installed with apt. Without them the audio, picture and
  video checks skip with a reason rather than pass.
- WebKit exposes no decoded video pixels to canvas, so the video frame identity
  check skips there. Audio and picture identity are checked in all three engines.
- Emulation only. Mobile projects emulate viewport, user agent and touch. No real
  iOS or Android device, no screen reader, no Axe run, and no accessibility
  conformance claim is made.
- The egress guard covers Node processes (in-process and via `--import`) and
  every browser request. A non-Node child process (for example ffmpeg or Python
  started by a product path) is not intercepted. The fake runtime keeps those
  paths from starting in these fixtures.
- UX01 is covered for active, paused and cancelled authority only. Exhausted,
  stale and rejected authority and duplicate-command cases are not covered yet.
- UX06 is exercised through the offline planner on the real server and the real
  Easy Studio. It reproduces the missing handoff and escape control; it does not
  yet assert the stable-focus/live-region behavior under frequent progress events
  or the planning-failure retry path.
- Fault injection before and after dispatch, selection commit and export commit is
  not built. It is the natural next extension (UX03, UX15, UX16).
- Product defect found while building this: `apps/web/src/easy/steps/index.ts` uses
  `import.meta.glob('./*.ts', { eager: true })`, which also loads `steps/*.test.ts`.
  Those import `node:test`, so the dev app throws `test is not a function` on load
  and every browser e2e under `apps/web/e2e` fails on this base. The acceptance
  Vite wrapper (`e2e/acceptance/vite.acceptance.config.ts`) stubs `node:test` for
  test-file importers only, leaving product code untouched. The Node baseline
  `easy-steps-glob` marks the defect; remove the wrapper plugin once the glob
  excludes tests.
- Observation, not asserted: during the Super Easy run the page keeps polling
  `GET /api/productions/:id` and receives 401 responses.
- `apps/server/src/app.mjs` and `apps/web/src/main.ts` are not modified.

# Editor browser tests

Playwright drives the Vite app and the local Comfyrizz server. Chromium only, headless, loopback only. No GPU, no Google Colab, no model calls, and no secrets. The harness generates a throwaway session token for that process and does not write it into the repo.

The server uses a temporary project directory and the editor fixture (the committed short package, plus narration takes so trim, split, and freshness can be seen). `?package=` on the app opens that stored project. Without the query, the bundled demo is unchanged.

## Run

From the repo root, with Node 22 and pnpm 10, after `pnpm install` and `pnpm -r --filter './packages/*' --if-present build`:

```sh
pnpm --filter @comfyrizz/web exec playwright install chromium
pnpm --filter @comfyrizz/web test:e2e
```

The script starts `apps/server` on `127.0.0.1:4391` and Vite on `127.0.0.1:4175`, then runs `apps/web/e2e/editor.spec.ts`. One Chromium worker, no retries. A full run should finish in under three minutes.

Set `CI=1` in continuous integration so `test.only` fails the run. Install the Chromium system libraries the Playwright package documents for that image (`playwright install --with-deps chromium` when the image has no browser libs).

## What is covered

Drag reorder, trim that floors below measured speech, zoom, Escape cancelling a drag, keyboard reorder, trim, and undo, shortcut keys typed into a focused field, autosave then reload, editable ZIP export and reimport, UI timeline versus `POST /api/compile` and the exported timeline, narration stale on one scene, split caption division, save states (Saved, Saving changes, Save rejected, Offline, revision conflict), media URLs without the session token, and an Axe scan that fails on serious or critical violations.

## Licences

New test code is MIT, like the rest of this repo.

| Package | Licence |
|---|---|
| `@playwright/test` | Apache-2.0 |
| `@axe-core/playwright` (and `axe-core`) | MPL-2.0 |

Axe is the scanner named by the editor test plan. MPL-2.0 is file-level; it is not applied to this repo's MIT sources.

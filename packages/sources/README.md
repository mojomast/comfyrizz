# `@comfyrizz/sources` — search, uploads, rights, credits (C4)

Everything that decides whether an asset may enter the project or `package.zip`.
No network call runs during render; the Openverse client is only used at edit time.

## Licence policy (v0.1)

| Licence | Search | Redistributable |
| --- | --- | --- |
| CC0-1.0, PDM-1.0 | yes | yes |
| CC-BY-* | yes | only after user approval + stored attribution |
| MIT | not an Openverse filter | when policy allows MIT and attribution is stored; archive includes the complete MIT notice |
| CC-BY-SA-* | blocked | no — share-alike obligations are not implemented |
| CC-BY-NC-*, CC-BY-ND-* | blocked | no — cannot be used in an edited video |
| unknown / all rights reserved | blocked | no |
| generated output | n/a | yes (defaults to CC0-1.0) |
| upload | n/a | only when the user marks it shareable |

`evaluateLicense()` canonicalises Openverse ids (`cc0`, `pdm`, `by`, `by-sa`,
`by-nc`, …), returns an allow/block decision and never marks an unapproved CC BY
asset as redistributable. `isAssetRedistributable()` is the single gate used by
credits and the zip builder.

MIT assets retain their own license rather than being relabeled CC0. The ZIP
builder includes `licenses/MIT.txt` with exact supplied per-asset attribution and
the full permission, conditions and disclaimer for assets that actually pass byte
and hash checks. Explicit license blocks and `redistributable: false` still win.
This supports original [curated CPU compositions](../../docs/COMPOSITIONS.md)
without changing GSAP's separate licensing terms.

## Openverse

`searchOpenverse({query, page, pageSize, orientation, apiToken})` calls
`https://api.openverse.org/v1/images/` with `mature=false` and a `license` filter
built from the policy (`cc0,pdm,by` by default). It maps each result to a
candidate with a canonical licence, attribution string and blocked reason; it
does **not** silently drop blocked candidates. A candidate is only
`redistributable` after approval.

Live smoke (2026-10-17, no token): `rocket launch` returned 240 results; the first
CC-BY-2.0 candidates were `allowed: true`, `redistributable: false` (approval
pending), as intended.

## Downloading a candidate

`downloadOpenverseCandidate(candidate)` fetches a chosen candidate over public https only (loopback/private hosts are rejected), caps the size, sniffs and hashes the bytes, and returns a `candidate`-status asset that is still `redistributable: false` until the licence is approved.

## Uploads

`inspectUpload({filePath, rightsAsserted, shareable})` refuses to read a file
until the user asserts rights, hashes the bytes, sniffs the type, and stores the
asset under `assets/<id><ext>` with `origin: upload`, `license.id: User-Upload`
and `redistributable: shareable`. An SVG upload is still marked for A5
sanitize/render-check before render.

## Credits

`buildCredits(pkg)` emits `credits.json` + a `CREDITS.md` table, and sets
`requiresEndCard` when a redistributable CC BY asset is present. Excluded assets
are listed with their source URL and hash under "fetch it yourself".

## `package.zip`

`buildPackageZip({package, timeline, assets, workflows})` writes a deterministic,
store-only zip containing `package.json`, `timeline.json`, the workflows,
`credits.json`, `CREDITS.md`, `manifest.json` and **only** redistributable assets
whose bytes match the recorded sha256. Everything else is listed in
`manifest.json` with a reason and the archive gets `INCOMPLETE.md` plus
`complete: false`. No keys, signed URLs or model weights are written.

```bash
npm test          # licence matrix, MIT notices, Openverse, uploads, credits, ZIP filtering/hashes
```

The zip writer has no dependency: it emits local headers, a central directory and
an EOCD with a fixed timestamp, so the same input produces byte-identical output.

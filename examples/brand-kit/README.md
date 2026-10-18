# Brand kit example

B1 lets an owner describe their brand once and have it followed everywhere:
the brief card, the generation prompts and the rendered video.

- `brand.json` — the loose kit the web card and `POST /api/brand` accept. Palette
  hexes, one font with a licence, tone words and a logo. The server normalises
  it with `normalizeBrandKit`, drops anything unsafe and reports warnings.
- `assets/brand/logo.svg` — the logo, referenced by `theme.logo_asset`. The
  renderer draws it top-left on the title and outro layouts and hides it
  gracefully if the file is missing.
- `package.json` — a renderable package whose `theme` is the result: the brand
  palette, `font: "Inter"` (the bundled fallback) and `logo_asset`.

## How it maps into the package

| Kit field | Package field |
| --- | --- |
| `palette` | `theme.palette` (lowercased, deduped, capped at 8) |
| `fonts[]` | `theme.fonts[]` (kept only with a file **and** a known-safe licence) |
| `logo` | an `origin: "upload"` asset + `theme.logo_asset` |
| `tone` | the brief's tone words (drives the outline and style block) |

A font is used only when it has both a file and a safe licence
(`OFL-1.1`, `Apache-2.0`, `MIT`, `CC0-1.0`, `UFL-1.0`, `BSD-3-Clause`, `ISC`,
`MPL-2.0`). Anything else is dropped and the kit falls back to Inter, which the
renderer always bundles. To ship a real brand font, commit the licensed file
under `assets/brand/` and add it to the package `theme.fonts`.

## Try it

```bash
# Normalise the kit without a browser (writes an uploaded logo only if inline).
node -e "import('./apps/server/src/brand.mjs').then(m => console.log(m.prepareBrand(JSON.parse(require('fs').readFileSync('examples/brand-kit/brand.json','utf8')))))"
```

# Comfyrizz Brand Assets (`Kinetic ZZ`)

This directory contains the hand-built vector SVG masters for the **Comfyrizz** (`Kinetic ZZ`) brand identity, derived from the approved concept in `brand/source/approved-concept.png` and token definitions in `brand/source/brand-tokens.json`.

## Identity Overview

- **Prose name**: Comfyrizz
- **Wordmark**: `comfyrizz` (all lowercase, heavy forward-slanted custom outline paths with **exactly two final `z` letters** echoing the double-Z symbol: first `z` in Violet `#6D28FF`, second `z` in Mint `#00D8AB`).
- **Symbol**: Two interlocking forward-leaning `Z` forms — upper/back `Z` in Violet (`#6D28FF`) and lower/front `Z` in Mint (`#00D8AB`) — separated by a uniform transparent overlap gap carved directly into the path geometry so no strokes, masks, or background plates are needed.

## Master Geometry & Construction Grid

All standalone and lockup masters share a single underlying coordinate geometry using integer coordinates and filled outline paths only (`fill`, no `stroke`, no `<text>`, no external fonts or embedded bitmaps):

| Asset | `viewBox` | Grid & Bounds | Slant Angle | Overlap Gap |
| :--- | :--- | :--- | :--- | :--- |
| `comfyrizz-symbol.svg` | `0 0 160 160` | `160 × 160` square grid; symbol occupies `x: 22..138`, `y: 24..136` (`116 × 112` units, `22–24` units safe padding on every side). Horizontal bars are `18` units thick; diagonal stems are `22` units wide horizontally (`45°` diagonal run). | `18.4°` (`dx:dy = -1:3`) on symbol terminal caps; `14.0°` (`dx:dy = -1:4`) forward slant across wordmark stems. | `4` vertical units (`y: 78..82`) and `6` horizontal units (`4.2` perpendicular units) along the diagonal interlock. |
| `comfyrizz-wordmark.svg` | `0 0 480 160` | `480 × 160` grid; 9 lowercase outline letter paths (`c`, `o`, `m`, `f`, `y`, `r`, `i`, `z`, `z`) spanning `x: 11..470`, `y: 32..136` (x-height `y: 56..112`, ascender `y: 32`, descender `y: 136`, stem weight `15` units, bar weight `12` units). | `14.0°` (`dx:dy = -1:4`) forward lean. | `4` units horizontal separation between the interlocking `z` pair (`#letter-z-1` and `#letter-z-2`). |
| `comfyrizz-logo-light.svg` | `0 0 628 160` | `628 × 160` horizontal lockup combining `#comfyrizz-symbol` (`0, 0`) and `#comfyrizz-wordmark` (`translate(136, 0)`) with identical `d` path strings and `22–24` units outer safe padding. | `18.4°` symbol caps / `14.0°` wordmark stems. | Identical `4`-unit vertical / `6`-unit horizontal symbol overlap gap. |
| `comfyrizz-logo-dark.svg` | `0 0 628 160` | Identical `628 × 160` lockup geometry and `d` strings as `comfyrizz-logo-light.svg`. | `18.4°` symbol caps / `14.0°` wordmark stems. | Identical `4`-unit vertical / `6`-unit horizontal symbol overlap gap. |
| `comfyrizz-logo-mono.svg` | `0 0 628 160` | Identical `628 × 160` lockup geometry and `d` strings; every shape uses `fill="currentColor"` with default `color="#14112B"`. | `18.4°` symbol caps / `14.0°` wordmark stems. | Identical `4`-unit vertical / `6`-unit horizontal symbol overlap gap. |
| `favicon.svg` | `0 0 32 32` | Simplified, hand-tuned `32 × 32` grid for `16–32 px` rendering; bounds `x: 3..29`, `y: 3..29` (`3` units safe padding, `5`-unit bar thickness). | `11.3°` (`dx:dy = -1:5`) terminal slant, `45°` diagonals. | Widened `2`-unit (`y: 15..17` and `dx = 2`) overlap gap for crisp pixel grid separation at `16 px`. |

## Clear Space & Minimum Sizes

- **Clear space**: Maintain a minimum clear space equal to **one half of the symbol height (`0.5 × H`)** on every side of the mark or lockup.
- **Minimum horizontal lockup width**: **`180 CSS px`** (`minLockupCssPx: 180`).
- **Minimum standalone symbol size**: **`24 CSS px`** (`minSymbolCssPx: 24`).
- **Small icon / favicon size**: Use **`brand/favicon.svg` at `16 px` (`16–32 CSS px`)**, where thicker bars and an enlarged `2`-unit overlap gap preserve the interlocking double-Z silhouette.

## Colourways & Token Palette

| Token | Hex | Role & Usage Notes |
| :--- | :--- | :--- |
| `violet` | `#6D28FF` | Upper/back `Z` in the symbol and first `z` in `comfyrizz`; primary brand action accent (`5.72:1` with `paper`, `2.97:1` on `ink` — do not use for small text on `ink`). |
| `mint` | `#00D8AB` | Lower/front `Z` in the symbol and final `z` in `comfyrizz`; supporting highlight (`9.97:1` with `ink`, `1.70:1` on `paper` — use `ink` text on mint buttons, never small mint text on `paper`). |
| `ink` | `#14112B` | Primary dark surface and light-mode wordmark lettering (`16.96:1` with `paper`). |
| `paper` | `#F7F5FC` | Primary light surface and dark-mode wordmark lettering (`16.96:1` with `ink`). |
| `surfaceDark` | `#211C38` | Elevated dark workspace surface. |
| `borderLight` | `#DED9EB` | Subtle border on light surfaces. |
| `mutedOnDark` | `#BEB7D0` | Secondary/muted text on dark surfaces (`9.50:1` on `ink`). |

### Lockup Colourway Selection

- **Light backgrounds (`#F7F5FC` Paper)**: Use `brand/comfyrizz-logo-light.svg` (`#14112B` Ink `comfyri` + `#6D28FF` Violet `z` + `#00D8AB` Mint `z`).
- **Dark backgrounds (`#14112B` Ink / `#211C38` Surface Dark)**: Use `brand/comfyrizz-logo-dark.svg` (`#F7F5FC` Paper `comfyri` + `#6D28FF` Violet `z` + `#00D8AB` Mint `z`).
- **Single-ink / monochrome reproduction**: Use `brand/comfyrizz-logo-mono.svg` (every shape set to `fill="currentColor"` with default `#14112B` Ink).

## File List

- `brand/comfyrizz-symbol.svg` — Standalone square double-Z symbol master (`viewBox="0 0 160 160"`).
- `brand/comfyrizz-wordmark.svg` — Standalone `comfyrizz` custom outline wordmark master (`viewBox="0 0 480 160"`).
- `brand/comfyrizz-logo-light.svg` — Horizontal lockup for light backgrounds (`viewBox="0 0 628 160"`).
- `brand/comfyrizz-logo-dark.svg` — Horizontal lockup for dark backgrounds (`viewBox="0 0 628 160"`).
- `brand/comfyrizz-logo-mono.svg` — Monochrome `currentColor` horizontal lockup (`viewBox="0 0 628 160"`).
- `brand/favicon.svg` — Simplified hand-tuned double-Z icon for `16–32 px` (`viewBox="0 0 32 32"`).
- `brand/README.md` — Geometry, clear space, minimum sizes, colourways, and asset reference documentation.
- `brand/source/` — Read-only design brief, brand guide, token JSON/CSS, contrast metrics, and approved concept reference PNGs.

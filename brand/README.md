# Comfyrizz Brand Assets (`Kinetic ZZ`)

This directory contains the hand-built vector SVG masters for the **Comfyrizz** (`Kinetic ZZ`) brand identity, derived from the approved concept in `brand/source/approved-concept.png` and token definitions in `brand/source/brand-tokens.json`.

## Identity Overview

- **Prose name**: Comfyrizz
- **Wordmark**: `comfyrizz` (all lowercase, heavy forward-slanted custom outline paths with rounded terminals, thick even stems, small counters, optical kerning with clear gaps between every letter, and **exactly two final `z` letters** that reuse the symbol's lightning-bolt `Z` shape scaled to x-height: first `z` in Violet `#6D28FF`, second `z` in Mint `#00D8AB`).
- **Symbol**: Two interlocking forward-leaning lightning-bolt `Z` forms — upper-left `Z` in Violet (`#6D28FF`) overlapping lower-right `Z` in Mint (`#00D8AB`) — with long tapered diagonal strokes ending in sharp points, short top and bottom bars tapering to points, and a clean, even transparent overlap gap carved directly into the path geometry so no strokes, masks, or background plates are needed.

## Master Geometry & Construction Grid

All standalone and lockup masters share a single underlying coordinate geometry using integer coordinates and filled outline paths only (`fill`, no `stroke`, no `<text>`, no external fonts or embedded bitmaps):

- **Shared Lightning-Bolt `Z` Geometry**:
  - **Symbol `Z` (`78 × 90` box)**: 6-vertex tapered lightning bolt with relative vertices `(3, 33) -> (78, 0) -> (42, 60) -> (75, 57) -> (0, 90) -> (36, 30)`. `#symbol-z-violet` is placed at origin `(17, 24)` (`d="M 20 57 L 95 24 L 59 84 L 92 81 L 17 114 L 53 54 Z"`), and `#symbol-z-mint` is an exact translation by `(+48, +21)` at origin `(65, 45)` (`d="M 68 78 L 143 45 L 107 105 L 140 102 L 65 135 L 101 75 Z"`).
  - **Wordmark `zz` (`52 × 60` box, exact `2/3` scale of the Symbol `Z`)**: Relative vertices `(2, 22) -> (52, 0) -> (28, 40) -> (50, 38) -> (0, 60) -> (24, 20)`, scaling the Symbol `Z` by `2/3` (`0.667×`) to fit the `60`-unit wordmark x-height (`y: 52..112`). `#letter-z-1` is placed at origin `(376, 52)` and `#letter-z-2` is translated by `(+42, 0)` at origin `(418, 52)`.
- **Wordmark Proportions & Optical Kerning (`c o m f y r i z z`)**:
  - **x-height**: `60` units (`y: 52..112`), ascender top `y: 28` (`f`, `i`), descender bottom `y: 136` (`y`).
  - **Stem weight**: `18` horizontal units across `c`, `o`, `m`, `f`, `y`, `r`, `i` (`18 / 60 = 0.30` of the x-height, within `0.28–0.32`), with `16`-unit horizontal bars/arches, small counters (`13–14` units wide in `o` and `c`, `10` units wide in `m`), and quadratic/cubic Bezier rounded terminals (`r = 3–4` units).
  - **Optical kerning**: Every letter is a distinct, non-overlapping outline path separated by a uniform `7–8` unit optical gap (including a clear `8`-unit gap between `#letter-m` and `#letter-f`).

| Asset | `viewBox` | Grid & Bounds | Slant Angle | Overlap Gap |
| :--- | :--- | :--- | :--- | :--- |
| `comfyrizz-symbol.svg` | `0 0 160 160` | `160 × 160` square grid; symbol occupies `x: 17..143`, `y: 24..135` (`126 × 111` units, `17–25` units safe padding on every side). Each `Z` is `78 × 90` units with a `24`-unit horizontal diagonal stem width (`0.27` of `Z` height). | `31.0°` (`dx:dy = -3:5`) along the lightning-bolt diagonal edges; `23.7°` (`dx:dy = 75:-33`) outer bar taper and `5.2°` (`dx:dy = 33:-3`) inner bar taper. | Uniform `5.2`-unit vertical bar gap and `5.4`-unit horizontal (`4.6`-unit perpendicular) diagonal interlock gap via `(+48, +21)` translation. |
| `comfyrizz-wordmark.svg` | `0 0 480 160` | `480 × 160` grid; 9 lowercase outline letter paths (`c`, `o`, `m`, `f`, `y`, `r`, `i`, `z`, `z`) spanning `x: 9..470`, `y: 28..136` (x-height `y: 52..112` = `60` units, stem width `18` units = `0.30` of x-height, bar height `16` units). | `14.0°` (`dx:dy = -1:4`) forward lean across `comfyri` stems; `31.0°` (`dx:dy = -3:5`) on the `2/3`-scaled `zz` diagonals. | `7–8` units optical kerning gap between adjacent letters; `5.6`-unit horizontal (`4.8`-unit perpendicular) interlock gap between `#letter-z-1` and `#letter-z-2`. |
| `comfyrizz-logo-light.svg` | `0 0 628 160` | `628 × 160` horizontal lockup combining `#comfyrizz-symbol` (`0, 0`) and `#comfyrizz-wordmark` (`translate(142, 0)`) with identical `d` path strings (`x: 17..612`, `16–17` units outer horizontal safe padding and `13`-unit gap between symbol and `c`). | `31.0°` symbol & `zz` diagonals / `14.0°` wordmark stems. | Identical `5.2`-unit vertical / `5.4`-unit horizontal symbol overlap gap. |
| `comfyrizz-logo-dark.svg` | `0 0 628 160` | Identical `628 × 160` lockup geometry and `d` strings as `comfyrizz-logo-light.svg`. | `31.0°` symbol & `zz` diagonals / `14.0°` wordmark stems. | Identical `5.2`-unit vertical / `5.4`-unit horizontal symbol overlap gap. |
| `comfyrizz-logo-mono.svg` | `0 0 628 160` | Identical `628 × 160` lockup geometry and `d` strings; every shape uses `fill="currentColor"` with default `color="#14112B"`. | `31.0°` symbol & `zz` diagonals / `14.0°` wordmark stems. | Identical `5.2`-unit vertical / `5.4`-unit horizontal symbol overlap gap. |
| `favicon.svg` | `0 0 32 32` | Simplified, hand-tuned `32 × 32` lightning-bolt double-Z for `16–32 px` rendering; bounds `x: 2..29`, `y: 4..28` (`16 × 20` per `Z`, translated by `(+11, +4)`, `5.5`-unit diagonal stem width). | `26.6°` (`dx:dy = -1:2`) diagonal slope with pointed lightning-bolt terminals. | Enlarged `2.5`-unit vertical and `1.5`-unit horizontal overlap gap for crisp pixel separation at `16 px`. |

## Clear Space & Minimum Sizes

- **Clear space**: Maintain a minimum clear space equal to **one half of the symbol height (`0.5 × H`)** on every side of the mark or lockup.
- **Minimum horizontal lockup width**: **`180 CSS px`** (`minLockupCssPx: 180`).
- **Minimum standalone symbol size**: **`24 CSS px`** (`minSymbolCssPx: 24`).
- **Small icon / favicon size**: Use **`brand/favicon.svg` at `16 px` (`16–32 CSS px`)**, where thicker lightning-bolt strokes and an enlarged overlap gap preserve the interlocking double-Z silhouette.

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

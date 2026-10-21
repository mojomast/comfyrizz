# Public film gallery on GitHub Pages

The five-film collection is published as a static site at:

**https://mojomast.github.io/comfyrizz/**

## Hosting layout

- **GitHub Pages:** gallery, five players, posters, chapter navigation, captions,
  scripts, credits and web-optimized **1280×720** H.264/AAC videos.
- **GitHub Releases:** original **1920×1080** exports and editable project ZIPs,
  with SHA-256 checksums under the `films-2026-10-20` media release.
- **Deployment branch:** `gh-pages`, rooted at `/`, with `.nojekyll`.

Initial deployment commit: `fe62ac4`. The publication is approximately **166 MB**;
its largest individual file is **37.2 MB**. Ten original download assets totaling
approximately **1.55 GB** are in Releases, with all ten GitHub-reported SHA-256
digests verified against local exports. Anonymous range requests to every original
download returned HTTP 206.

The [initial Pages deployment](https://github.com/mojomast/comfyrizz/actions/runs/39433050108)
completed successfully. Public Chromium checks passed for all five players at
1280×720, 28 chapter buttons per film, mid-film and final-chapter seeking, caption
delivery and release download links. Desktop and mobile gallery checks passed.
HTTPS is enforced. Temporary local preview servers were stopped after verification.

Pages serves the public viewing experience. The project editor's server, generation
workers, authentication and GPU controls are not part of this static deployment.

The split keeps the published site under GitHub Pages' 1 GB limit and each Git file
under GitHub's large-file threshold. Full-resolution videos and editable projects
retain their original export bytes. Web copies retain the exact edit and frame
count, with an early MP4 index for playback and seeking.

## Build a publication

From verified local film publications:

```bash
node scripts/demos/github-pages.mjs \
  apps/web/dist /external/pages-site /external/release-assets \
  mojomast/comfyrizz films-2026-10-20
```

The builder accepts only the five known publication directories, requires their
verification checks to pass, copies allowlisted public files, creates web video
encodes, rewrites download links to the release, and emits `media-manifest.json`.
It does not copy server state, tokens, application bundles, or private media URLs.

Requirements: Node.js, FFmpeg/ffprobe, and the existing verified film publications.
Use fresh output directories outside the source publication tree. Browser checks
also require the web package's Playwright installation and Chromium.

Publish the generated site through a normal commit on `gh-pages`. Attach the
generated `*-1080p.mp4`, `*-project.zip` and `SHA256SUMS.txt` files to the matching
release. Enable Pages with the `gh-pages` branch and `/` source. Use a new release
tag for a new collection revision so existing download links stay stable.

## Verification

Before deployment, check internal links under the repository's `/comfyrizz/` base
path, gallery layout on desktop/mobile, local video playback, chapter seeking,
frame counts, release asset checksums, and absence of private addresses or tokens.
After deployment, check the public Pages build and repeat playback/seek tests on
all five public players. The site includes a machine-readable delivery manifest;
the release includes checksums for original downloads.

```bash
node scripts/demos/verify-pages.mjs \
  https://mojomast.github.io/comfyrizz/ \
  /external/pages-site/media-manifest.json /external/pages-verification.json
```

For a local preview, serve the site under `/comfyrizz/` with HTTP byte-range support
so chapter seeking behaves like Pages. A basic server without range support can
play the opening while failing seeks into media that has not yet been buffered.

Source documentation, authoring skills and reproduction scripts live on `main`;
the generated static publication lives on `gh-pages`. Pushing `main` does not
redeploy the Pages site or restart the application server. The skill catalogue
1.3.0 source changes require a separate application deployment to become live.

References: [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
and [distributing large binaries with releases](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github#distributing-large-binaries).

# Public film gallery on GitHub Pages

The five-film collection is published as a static site at:

**https://mojomast.github.io/comfyrizz/**

## Hosting layout

- **GitHub Pages:** gallery, five players, posters, chapter navigation, captions,
  scripts, credits and web-optimized **1280×720** H.264/AAC videos.
- **GitHub Releases:** original **1920×1080** exports and editable project ZIPs,
  with SHA-256 checksums under the `films-2026-10-20` media release.
- **Deployment branch:** `gh-pages`, rooted at `/`, with `.nojekyll`.

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

The source worktree's in-progress research, skills and production changes are
separate from the static deployment branch.

References: [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
and [distributing large binaries with releases](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github#distributing-large-binaries).

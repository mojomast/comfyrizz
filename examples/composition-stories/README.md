# Three composition stories

Source-only example: 1280×720, 30 fps, no narration, three hard-cut scenes totaling
480 frames (16 seconds). No generated media is checked in.

1. **Object transfer, 5 s:** Receipt → Project Atlas → Assigned.
2. **Mechanism journey, 6 s:** Input → Review → Result.
3. **Evidence reveal, 5 s:** Before 12 minutes, After 7 minutes.

All numbers are **illustrative**, invented for this example. The v1 dataset uses
`source: "example"`, with the citation in its note and visible scene footnote.
It is not a measured performance claim.

Edit `package.json` and `compositions/manifest.json`, then run from the repo root:

```bash
pnpm --filter @comfyrizz/planner build
node scripts/compositions/build.mjs examples/composition-stories --check
```

For optional rendering, configure the pinned external HyperFrames CLI and Node 22
as described in [the composition guide](../../docs/COMPOSITIONS.md), then:

```bash
node scripts/compositions/build.mjs examples/composition-stories \
  --out /tmp/opencode/composition-stories-built
```

Use a fresh destination. `package.json` in that directory remains the editable
source; `rendered-package.json` is the materialized view for the final render
pipeline. Keep both files and the manifest for manual source round-trip.

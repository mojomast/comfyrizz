# Pip, a recurring mascot

CAST1 example: the same fictional character in every scene, via a FLUX 3 Klein reference edit.

`assets/pip.svg` is a synthetic mascot drawn as SVG (a circle, two dots, a curve). It is not a photo of a real person, and nothing here was made on a GPU or in Google Colab. `cast[0].ref_asset` points at that file. Each pending still names `c_pip`, so the planner turns it into `workflows/flux3_klein_ref_edit.api.json` and uploads `assets/pip.svg` as the reference image. The cache key includes that file's sha256.

`presenter.portrait` is the cast id `c_pip` and `presenter.enabled` is false. That is the optional hook for a presenter portrait that is a cast member. A package with no `cast` array is unchanged.

Plan it with `node packages/jobs/bin/plan-jobs.mjs examples/cast-mascot/package.json`. The stills stay pending until a spend is approved; this package does not run a model.

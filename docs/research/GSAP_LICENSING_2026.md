# GSAP licensing: practical options for Comfyrizz

**Researched October 20, 2026.** Companion to the
[HyperFrames integration report](HYPERFRAMES_2026.md).
This is an engineering assessment of published terms and official clarification;
it is not a product-specific permission from Webflow or a legal opinion.

## Recommendation

There is a credible permitted-use path for **AI-authored scenes and curated
animation presets with parameter controls**. Keep the default composition format
engine-independent, use native frame functions for general editing, and make GSAP
an optional scene implementation. Before distributing a GSAP-powered authoring
integration, ask Webflow to confirm the actual combined Comfyrizz workflow,
including its current editor and editable project downloads.

This is more nuanced than “visual controls require a separate license.” The
official FAQ encourages niche visual tools, and a GSAP administrator publicly
approved a specific preset-plus-parameters commercial plugin. A general-purpose
visual animation/keyframe builder has less clear coverage and should be described
separately in the request below.

We can advance HyperFrames rendering and visual QA without waiting on GSAP:
a local frame-source experiment rendered successfully without loading the GSAP
library. Engine isolation is useful architecture, **not a license exemption**.

The subsequent [composition implementation](../COMPOSITIONS.md) takes that non-GSAP
path: curated native frame functions and a replaceable HyperFrames worker. No
GSAP runtime is bundled by the feature, and the inquiry below remains unsent.

## 1. What the current terms actually say

The [Standard License][license] states an effective date of **April 30, 2025** and
last modification date of **May 30, 2025**, as retrieved on October 20, 2026.

| Provision | Meaning for the proposed work |
|---|---|
| §I: permitted use on websites, web applications and digital interfaces, including companies competing with Webflow in other areas | Commercial competition alone is not the restriction |
| §I: prohibited uses involve tools allowing users to build visual animations without code that encourage, induce or materially assist a solution competing with Webflow's visual animation-building capabilities | The actual animation-authoring capabilities matter; “video app” is not an explicit categorical exemption |
| §I: competitive products include visual animation creation/editing/management interfaces similar to Webflow | A full animation inspector/keyframe editor deserves explicit review |
| §III(a): prohibited uses require **prior written consent** | Consent is an available route; the text does not promise a standard price or that every request will be granted |
| §III(b): no reverse engineering GSAP to create competitive products | Prefer independently written frame functions or appropriately licensed libraries for a general editor |
| §III(c): no removing/altering proprietary notices or branding from GSAP products | Preserve library headers and relevant notices in bundles/downloads |
| FAQ: “AI-generated code is not a ‘Prohibited Use’” | Strong support for agents generating GSAP source; it does not expressly approve every surrounding visual editor |
| FAQ: commercial use, including formerly paid plugins, is available at no charge | No standard per-render charge or former Club membership requirement for permitted uses |
| §VI: license amendments; continued-use language; previous versions may continue under previously applicable terms, excluding updates | Pin exact versions, retain the applicable terms and review upgrades; pinning is not permission for an otherwise prohibited use |

The license incorporates Webflow's Terms of Service, with the GSAP license taking
precedence for conflicts concerning GSAP. Product-specific legal review should
include the incorporated terms, not just the FAQ.

### Official examples help narrow the uncertainty

**June 23, 2026 — public permitted-use confirmation.** A developer described a
commercial Elementor/WordPress plugin with curated GSAP presets and controls for
duration, easing, delay, stagger and scroll/trigger settings. It had no blank-canvas
timeline or arbitrary keyframe authoring and would bundle GSAP. GSAP administrator
**Cassie** replied: **“This falls under permitted use!”**

Source: [GSAP Lisence — official forum][presets]. This is useful evidence for
Comfyrizz's preset model, not a transferable written consent covering all future
Comfyrizz features. Statements about GPL in that thread are the questioner's
description, not a separate detailed legal analysis by the administrator.

**September 22, 2026 — product-specific answer was private.** Another developer
asked about a tool to position/timestamp one animated character with a draggable
authoring strip, and about later self-service use. Administrator GreenSock said an
answer was sent privately. The public thread contains **no approval or rejection**
to rely on. Source: [Do I need a license?][private-answer].

## 2. Map the terms to Comfyrizz's actual features

| Use | Assessment from the published material | Practical implementation |
|---|---|---|
| Developer writes GSAP code for an authored film | Ordinary animation use is strongly supported | Paused timelines, measured frame cues, preserved dependency notices |
| Agent writes GSAP code from a chat instruction | Explicitly supported by the AI-code FAQ | Keep the source and measured scene contract; describe the surrounding editor in the inquiry |
| User selects a curated effect and adjusts parameters | Strong official precedent for a similar preset tool | Versioned components with bounded, meaningful controls |
| User edits narration/captions, reorders clips or trims scenes | Not itself the same as arbitrary animation building | Explain these existing features accurately; do not claim they eliminate all ambiguity |
| User selects any element and freely animates properties/keyframes | Closest to the restricted category | Obtain specific written confirmation/consent or implement that feature with non-GSAP code |
| Server renders generated GSAP scenes to MP4 | Server placement does not decide permitted use | Evaluate the product enabling the render, not only where the library runs |
| Finished MP4 is sold/published | Encoded pixels do not bundle the GSAP JavaScript library | No video watermark requirement is stated in the reviewed terms; rights for source assets still apply |
| Editable HTML/JS or worker image is distributed | Software/dependencies are being supplied, not just pixels | Preserve notices, identify the separate GSAP license and clarify downstream distribution scope |
| An optional plugin/user-supplied GSAP install powers the same visual builder | Optional installation is not a permission workaround | Treat as the same licensing question for that functionality |

Do not describe Comfyrizz as having “no editor.” It already has a scene timeline,
animation controls, undo/redo, narration editing and source-preserving downloads.
We can explain the distinction between **editing clips and preset parameters**
and **authoring arbitrary object animation**, but Webflow should see the full facts.

## 3. MIT project, separate dependency terms

Comfyrizz's root license is **MIT**. Using GSAP does not, by itself, require changing
the license of our independently written code or making the project closed-source.
However, it does not let us license GSAP itself under MIT.

For a permitted GSAP integration:

- Keep Comfyrizz's code under MIT; explicitly identify third-party exceptions.
- Preserve the GSAP copyright/license header. The tested `gsap@3.13.0` minified
  bundle contains an `@license` comment linking to the Standard License.
- Include a third-party notice and the applicable license text/link alongside
  redistributed runtime dependencies; ensure production minification retains notices.
- Describe a full distribution accurately as containing MIT application code and
  separately licensed dependencies. Do not market the entire GSAP-inclusive bundle
  as unrestricted MIT/Apache or all-OSI-open-source software.
- State that GSAP use by downstream users remains subject to its terms. Ask whether
  any product-specific consent covers self-hosters, forks, customer installations
  and hosted deployments; do not assume our permission transfers to all derivatives.
- Keep runtime dependencies separate from the license of original scene content.
  Exporting our scene script does not relicense its GSAP runtime, fonts or media.

The current terms are use-restricted rather than copyleft. The primary issue for
our MIT project is the additional restriction on some uses, not a requirement to
publish our application source. A GPL distribution is a separate compatibility
question; the fact Comfyrizz is MIT should not be generalized to every downstream
repackaging.

Neither the reviewed license nor FAQ requires buying a Webflow hosting plan,
adding a GSAP logo to the finished video, or paying a royalty for permitted
commercial renders. This is separate from retaining notices in the software.

## 4. HyperFrames does not erase GSAP's terms

HyperFrames is Apache-2.0, while its GSAP-based examples/components depend on GSAP's
separate license. Its [credits][credits] explicitly identify GSAP licensing for
vendored/catalog material. The repository's Apache license is not evidence of
special consent for Comfyrizz, and no reviewed public source establishes such consent.

The inspected core/engine/producer/CLI/player package manifests have no direct
GSAP npm dependency, but this alone is insufficient to declare a distribution
GSAP-free: templates and registry scenes can load GSAP via script tags or vendor it.
The compiler can even rewrite certain missing local GSAP references to CDN URLs.
Audit actual compiled scenes, vendored files, fetched scripts and shipped bundles.

The upstream issue [#2334][metadata-issue] concerned a missing package `license`
metadata field; it was not a GSAP licensing ruling.

### A tested alternative: HyperFrames without GSAP animation

I adapted the receipt scene to use an independently written function of time and
`window.__hyperframes.registerFrameSource`, with `data-no-timeline` on the root.
The scene loads no GSAP script and contains no GSAP library asset. Its render callback
throws if a non-null `window.gsap` is present. It uses native DOM transforms,
linear fades and a simple smoothstep interpolation for the transfer.

- `hyperframes@0.8.181` lint, runtime, layout, motion and contrast checks passed.
- Render succeeded with strict readiness and best-effort disabled.
- FFprobe measured **120 frames, 30 fps, 1280×720, 4.000 seconds**, H.264.
- Four sampled export frames showed the receipt moving and the result appearing.
- This proves a working scene-animation path without a loaded GSAP runtime, not a
  complete dependency/license audit of every HyperFrames package or catalog file.

The initial probe guard incorrectly rejected `null`: HyperFrames' own early stub
defines a `window.gsap` getter initialized to null before a library loads.
Changing the guard from a `typeof !== 'undefined'` test to `window.gsap != null`
fixed that false positive. The stub is not the GSAP library.

Raw source, checks, failed-guard log and successful render are retained under
`~/comfyrizz-gpu-tests/hyperframes-research-20261020/frame-source/`.
The [evidence summary](hyperframes-evidence-20261020.json) records the successful
output and source hashes. This experiment spent **zero Colab credits**.

For more sophisticated non-GSAP animation, consider the current native renderer,
CSS/Web Animations, or [Anime.js, whose repository license is MIT][anime-license].
Each alternative still needs exact-seek tests; the MIT license does not guarantee
feature or rendering parity with GSAP plugins. Many upstream catalog scenes would
need porting rather than a simple library substitution.

## 5. A concrete adoption plan

1. **Keep the saved animation contract neutral.** Store scene duration, cue frames,
   component name/version and parameters independently of GSAP timeline objects.
2. **Use native frame functions for default and general-purpose editing.** Adopt
   HyperFrames' checks and design/blueprint approach where useful.
3. **Scope an optional GSAP preset/AI-authoring adapter.** Describe its exact
   controls, hosted/self-hosted use and exports in the request below.
4. **If that scope is confirmed, pin versions and ship with notices.** Add a
   dependency/license manifest to editable exports and runtime distributions.
5. **Treat a future freeform GSAP animation editor as an explicit scope change.**
   Obtain consent covering it, or keep that implementation on independently written
   native/MIT components. A worker process or “AI-powered” label does not change
   the permissions for an otherwise restricted product.

The engineering proposal needs a product-scoped answer, not permission for every
ordinary animation in a video. Webflow's [contact form][contact] has a
**Licensing Question** category. The following draft is ready to send; it has
**not been submitted**.

## 6. Draft licensing inquiry

**Subject: GSAP permitted-use clarification for Comfyrizz, an MIT video-authoring app**

Hello GSAP/Webflow licensing team,

We maintain Comfyrizz: https://github.com/mojomast/comfyrizz, an MIT-licensed,
self-hostable video-authoring application. We are evaluating an optional GSAP
integration, potentially through the Apache-2.0 HyperFrames renderer.

Our primary output is rendered video, not an interactive website builder. Users
describe videos in chat; an agent prepares scripts and scenes. Our current editor
also supports scene reordering/trimming, narration and caption editing, animation
recipe parameters, transitions and undo/redo. We provide editable project downloads.

Our proposed initial GSAP use would:

- Allow AI-generated or developer-authored GSAP scene code.
- Offer curated animation components with controls such as content, duration,
  easing, reveal order and narration-synchronized cue timing.
- Render paused GSAP timelines at exact frame times in a local/server worker.
- Produce MP4s and potentially editable HTML/JS scene packages with local runtime
  dependencies and preserved notices.
- Support self-hosted installations and potentially a commercial hosted service.

The initial integration would not expose a blank-canvas, arbitrary object-property
keyframe editor. We may consider such a feature later, and would like its status
answered separately rather than assuming it has the same permission.

We have read the Standard License and its AI-code/niche-tool FAQ, as well as the
June 23, 2026 forum confirmation for a preset-plus-parameters plugin:
https://gsap.com/community/forums/topic/45477-gsap-lisence/

Could you please confirm:

1. Does the combined initial workflow above qualify as a Permitted Use under the
   current Standard License, including its existing video timeline/editor controls?
2. Is bundling GSAP in our distributed application/worker and users' editable
   scene downloads permitted with notices retained? Are there additional requirements?
3. How does that answer apply to self-hosters, customer installations, commercial
   hosting and forks of our MIT application? Does any product-specific permission
   need to name particular entities or distribution channels?
4. Would a later freeform animation/keyframe editor require prior written consent?
   If so, could you describe available terms and the required approval scope?
5. If any initial functionality above is considered a Prohibited Use, would you
   grant prior written consent under §III(a), and on what conditions?

Please distinguish confirmation under the standard terms from any special consent,
and identify the covered product scope, applicable versions and any conditions.
We can supply screenshots, a demo and a more detailed architecture description.

Thank you.

## Sources and evidence

- [GSAP Standard License and official FAQ][license] — primary terms.
- [Preset-plus-parameters permitted-use confirmation][presets] — official public reply.
- [Character-authoring inquiry][private-answer] — response private; outcome unknown.
- [GSAP licensing contact][contact].
- [HyperFrames credits][credits] and [license metadata issue][metadata-issue].
- [HyperFrames frame-source contract][frame-sources] and [early GSAP interception stub][stub].
- [Anime.js license][anime-license] — alternative library, not a GSAP permission.

Retrieved license/forum/contact HTML snapshots and SHA-256 source manifest are
retained outside the repository in
`~/comfyrizz-gpu-tests/hyperframes-research-20261020/licensing/`.

[license]: https://gsap.com/community/standard-license/
[presets]: https://gsap.com/community/forums/topic/45477-gsap-lisence/
[private-answer]: https://gsap.com/community/forums/topic/45558-do-i-need-a-license/
[contact]: https://gsap.com/contact/
[credits]: https://github.com/heygen-com/hyperframes/blob/6d357ff0d8dbb88b8d19fe689c15f0808724e52a/CREDITS.md
[metadata-issue]: https://github.com/heygen-com/hyperframes/issues/2334
[frame-sources]: https://github.com/heygen-com/hyperframes/blob/6d357ff0d8dbb88b8d19fe689c15f0808724e52a/docs/guides/frame-sources.md
[stub]: https://github.com/heygen-com/hyperframes/blob/6d357ff0d8dbb88b8d19fe689c15f0808724e52a/packages/producer/stubs/hf-early-stub.ts
[anime-license]: https://github.com/juliangarnier/anime/blob/master/LICENSE.md

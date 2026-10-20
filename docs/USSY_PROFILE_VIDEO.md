# SLOPTIMUS PRIME — the man behind ussy.host

Creator-profile video requested on 2026-10-19. Produced with the application's
CPU pipeline: local Kokoro speech synthesis, measured narration timing, Remotion
composition, final-audio normalization, verification and portable export.

## Editorial brief

An eight-scene profile of the creator's public work, using the site's public
identity **SLOPTIMUS PRIME** and GitHub handle **mojomast**. The script contains
235 spoken words. The visual treatment combines warm-gold accents, dark-blue
backgrounds, animated typography, authentic site screenshots and conceptual
motion diagrams.

1. **The creator:** SLOPTIMUS PRIME and the instinct to reshape tools.
2. **The publication:** *Slop Illustrated*, October 2026, with eleven projects.
3. **OrbitDesktop:** an agent-customizable browser workspace powered by Hermes.
4. **VelvetRP:** model-proposed storytelling with server-validated outcomes.
5. **RGB Agent Flight Indicator:** visible agent-session status on keyboard lights.
6. **The range:** JamMate, RouteTok, MothBake and CoCS.
7. **The editorial principle:** “Show the work. Credit the foundations.”
8. **The invitation:** explore the projects and their sources at ussy.host.

The description of the creator's personality is editorial interpretation of his
public work. The video makes no private biographical claims. The screenshots are
from the creator-provided site, reused for his requested profile, with their
underlying rights retained. They are identified as owner-provided imagery in
the editable package; they have not been assigned a public-domain license.

## Sources

- [ussy.host / Slop Illustrated](https://ussy.host)
- [Site project catalog](https://ussy.host/js/projects.js)
- [GitHub / mojomast](https://github.com/mojomast)
- [OrbitDesktop](https://github.com/mojomast/orbitdesktop)
- [OrbitDesktop screenshot](https://ussy.host/assets/screenshots/orbitdesktop.png)
- [VelvetRP screenshot](https://ussy.host/assets/screenshots/velvetrp.png)

The project count describes the October 2026 issue, rather than an all-time count
of repositories. Source material is archived alongside the production output.

## Production

- Format: 1920 × 1080, 30 fps.
- Measured timeline: 3,302 frames, 110.067 seconds, 19 sentence-caption cues.
- Narrator: Kokoro `am_michael`, US English, speed 0.98.
- Scene changes: hard cuts with scene-local typography and diagram animation.
- Captions: measured sentence timing; Kokoro word timing is estimated.
- Presenter: typographic creator identity; no synthesized portrait or cloned voice.
- GPU allocations: none.
- Local archive: `/home/mojo/comfyrizz-gpu-tests/ussy-profile-20261019/`.
- Frontend implementation files are not part of this production task.

All eight narration takes fit their scene windows. Scene-local voice/allocated
durations in seconds are 10.59/10.97, 13.04/13.07, 13.39/13.73, 14.84/15.20,
15.37/15.73, 13.47/13.83, 14.35/14.70 and 12.66/12.83.

## Published output

- [Watch the video](https://mail.tailec998.ts.net:8451/ussy-profile/index.html)
- [MP4](https://mail.tailec998.ts.net:8451/ussy-profile/video.mp4)
- [Editable project ZIP](https://mail.tailec998.ts.net:8451/ussy-profile/package.zip)
- [Captions](https://mail.tailec998.ts.net:8451/ussy-profile/captions.srt)
- [Script](https://mail.tailec998.ts.net:8451/ussy-profile/script.md)
- [Technical verification](https://mail.tailec998.ts.net:8451/ussy-profile/verification.json)

Pipeline run: `pipe_8b373a11ca164e139e137096ab741622`. Final MP4 is **7,118,778
bytes**; editable ZIP is **11,797,410 bytes**. MP4 container duration is 110.080
seconds, with 3,302 video frames and 48-kHz audio.

The pipeline passed frame count, geometry, duration, narration-stream,
non-silent-audio, narration-envelope and ZIP/asset-hash checks. Final mix versus
original narration RMS-envelope correlation: **0.99999424**. Mid-scene frames
from all eight scenes were reviewed for layout, imagery and caption clearance.
Continuous paired audiovisual playback was not reviewed; the desktop browser
was disconnected. Technical checks are distinct from perceptual review.

Publication was verified with a successful player GET, an MP4 HTTP **206** byte
range containing exactly 1,024 bytes, and a ZIP response matching its expected
size. No Colab allocation occurred. The page is served from the ignored static
output directory `apps/web/dist/ussy-profile/`; rebuilding the web app clears
it. The player, source package, outputs and production helpers are preserved in
the local archive for republishing.

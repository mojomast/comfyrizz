// Recorded 2026-10-29 olive Action attempt: brief.txt and initial tool transcript
// 9b83320d… in /tmp/opencode/olive-anchor-20261029. No generated pixels.
export const OLIVE_BRIEF = 'Reduced Action anchor — OLIVE ON LINEN. Exactly 6 seconds, one continuous photorealistic macro shot, landscape 16:9. One green olive rolls left to right in a straight line directly across flat ivory linen, slows naturally and comes completely to rest for the final two seconds. Locked-off camera, soft daylight, consistent olive size and contact shadow. Only the single olive and linen are visible. No tray, plate, people, hands, cuts, transitions, titles, captions, narration, music, sound effects, opener or outro. Silent output. Use the selected existing LTX-2.5 generated-video route, not procedural animation. One shot and one candidate only. If the supported LTX workflow requires I2V, use only one necessary Klein starting keyframe plus one LTX video, with the source still matching the package output dimensions. No character design, references, variants or additional jobs. This is a new reduced six-second brief, not TABLE12.';

export const OLIVE_IMAGE = {
  scene_id: 's__1e908a2f315',
  intent: 'A single glossy green olive with a smooth firm skin and a small dimple rests on the left third of flat ivory linen laid taut and smooth, real woven fabric fibre visible in extreme close-up macro. Soft diffused daylight from the upper left rakes across the olive and casts one short, soft contact shadow beneath it. Photorealistic live-action macro photography, shallow depth of field, natural real-world materials, calm and restrained mood.',
  aspect: '16:9', kind: 'keyframe', seed: 41277,
};

export const OLIVE_VIDEO = {
  action: 'The olive rolls steadily from left to right in a straight line across the linen, then slows smoothly and comes completely to rest, staying perfectly still through the last two seconds.',
  camera: 'Locked-off static macro camera, no push, orbit or crop',
  characterCount: 0,
  composition: 'Flat ivory linen fills the frame edge to edge in extreme close-up macro; the olive travels straight across the middle band of the cloth with one soft consistent contact shadow, soft diffused daylight from the upper left, photorealistic live-action texture, consistent olive size.',
  finishing_sound: 'Full silence: no ambience, no foley, no room tone, no music, no effects.',
  frames: 144, image: 'a_img_2722715790977bed', motion_model: 'ltx',
  scene_id: 's__1e908a2f315', seed: 41277,
  soundscape: 'Silence; the picture only.',
  subject: 'A single green olive with glossy firm skin and one small dimple, resting on flat ivory linen',
};

export const OLIVE_PROPOSE = {
  brief: OLIVE_BRIEF, title: 'Olive on Linen',
  proposal: {
    logline: 'A single green olive rolls across flat ivory linen, slows, and settles to a complete stop.',
    look: 'Photorealistic macro, soft daylight, ivory linen, one green olive',
    soundtrack: 'None. Full silence: no music, ambience or effects.',
  },
  // Already-normalized scene ID and timing from the saved package.
  scenes: [{ id: OLIVE_IMAGE.scene_id, layout: 'hero', preferredFrames: 180, media_only: true }],
};

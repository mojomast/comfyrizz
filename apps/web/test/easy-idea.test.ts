// @ts-nocheck
// UR10: the Idea step render, the brief prompt and the short-idea error.

import test from 'node:test';
import assert from 'node:assert/strict';

import { COPY } from '../src/easy/copy.ts';
import { defaultEasyState } from '../src/easy/store.ts';
import { templateChangeNeedsConfirm, templateChangePlan, step } from '../src/easy/steps/idea.ts';
import { ideaPrompt } from '../src/easy/idea-prompt.ts';
import { classifyProductionIntent } from '../../../packages/agent/src/production-intent.ts';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { OLIVE_BRIEF } from '../../../packages/agent/test/fixtures/olive-action.ts';
import { FICTIONAL_DATA_STORY, FICTIONAL_DATA_STORY_UI } from '../../../packages/agent/test/fixtures/fictional-data-story.ts';
import { LAST_SIGNAL_CREDITS, LAST_SIGNAL_SPEAKING } from '../../../packages/agent/test/fixtures/last-signal.ts';

// Actual first-pass UI text from 24h-small-data/evidence, before appended settings.
const RECORDED_DATA_STORY = FICTIONAL_DATA_STORY;

test('custom 120 seconds and exactly two minutes serialize and compile to an exact 3600-frame film', () => {
  for (const text of ['A fictional documentary about a clock repairer.', 'Create exactly 2 minutes of a fictional documentary.']) {
    const state = defaultEasyState();
    state.idea.text = text;
    state.idea.lengthS = 120;
    const prompt = ideaPrompt(state);
    assert.doesNotMatch(prompt, /about 120 seconds/);
    if (!text.includes('2 minutes')) assert.match(prompt, /Length: exactly 120 seconds/);
    const intent = classifyProductionIntent(prompt);
    assert.equal(intent.requestedSeconds, 120);
    assert.equal(intent.exactDuration, true);
    const timeline = compileTimeline({
      id: 'pkg_documentary_duration', title: 'Fictional documentary',
      format: { width: 1920, height: 1080, fps: 30 },
      duration: { mode: 'target', targetFrames: intent.requestedSeconds * 30, exact: intent.exactDuration },
      scenes: Array.from({ length: 10 }, (_, i) => ({
        id: `s${i}`, layout: 'title', preferredFrames: 360,
        copy: { headline: `Chapter ${i + 1}` },
        transitionOut: { type: i === 9 ? 'none' : 'fade', frames: i === 9 ? 0 : 15 },
      })),
    });
    assert.equal(timeline.durationInFrames, 3600);
    assert.equal(timeline.scenes.at(-1).from + timeline.scenes.at(-1).durationInFrames, 3600);
    assert.equal(timeline.target.requiresAcceptance, false);
  }
});

test('recorded fictional Data Story keeps its medium and 20-second output runtime', () => {
  const state = defaultEasyState();
  state.videoType = 'data-story';
  state.idea.text = RECORDED_DATA_STORY;
  state.idea.lengthS = 20;
  const prompt = ideaPrompt(state);
  assert.equal(prompt, FICTIONAL_DATA_STORY_UI);
  assert.ok(prompt.startsWith(RECORDED_DATA_STORY));
  assert.doesNotMatch(prompt, /Look: photorealistic live-action/);
  const intent = classifyProductionIntent(prompt, 'motion-graphics');
  assert.equal(intent.kind, 'motion-graphics');
  assert.equal(intent.liveActionHumans, false);
  assert.equal(intent.requestedSeconds, 20);
  assert.equal(intent.exactDuration, true);
});

test('look inference respects negation and native/chart medium while preserving positive live action', () => {
  for (const text of [
    'This is not a claim about real people.',
    'No real people. Use native motion graphics.',
    'Do not show realistic humans.',
    'Avoid photorealistic images, real people and live-action footage.',
    'Use charts about real people.',
    'Use native editable typography to tell a story about real humans.',
    'Use charts instead of live action.',
  ]) {
    const state = ideaState();
    state.idea.text = text;
    assert.doesNotMatch(ideaPrompt(state), /Look: photorealistic live-action/, text);
    assert.equal(classifyProductionIntent(ideaPrompt(state)).liveActionHumans, false, text);
  }
  for (const text of [
    'Show real people in a bakery.',
    'No charts. Show real people in a bakery.',
    'No charts. A film with real people in a bakery.',
    'Show real people alongside native chart overlays.',
    'Create a live-action film.',
    'Use photorealistic humans with native chart overlays.',
    'No charts, use live action.',
    'Avoid cartoons and use realistic humans.',
    'No real people in the opening. Show live-action humans in the ending.',
    'Not only live action, but also charts.',
  ]) {
    const state = ideaState();
    state.idea.text = text;
    assert.match(ideaPrompt(state), /Look: photorealistic live-action/, text);
  }
});

const facts = {
  hasPackage: false,
  planApproved: false,
  actionsActive: false,
  allShotsKept: false,
  exportCurrent: false,
};

test('recorded olive Action and other photographic subjects never acquire human direction', () => {
  for (const text of [OLIVE_BRIEF, 'A live-action landscape shot of waves.', 'Photorealistic wildlife: a fox running.', 'Live-action product photography of a watch. No people.']) {
    const state = ideaState();
    state.videoType = 'action-scene';
    state.idea.text = text;
    const prompt = ideaPrompt(state);
    assert.ok(prompt.startsWith(text));
    assert.match(prompt, /Look: photorealistic live-action, natural light and real-world materials\./);
    assert.doesNotMatch(prompt.slice(text.length), /humans?|people|skin/);
    assert.equal(classifyProductionIntent(prompt).liveActionHumans, false, text);
    assert.equal(classifyProductionIntent(prompt).kind, 'generated-film');
  }
});

test('subject-neutral look preserves explicitly requested live-action human subjects', () => {
  for (const text of ['Show real people in a bakery.', 'Use photorealistic humans with native chart overlays.', 'A live-action baker kneads dough.', 'No charts. Show realistic humans.']) {
    const state = ideaState();
    state.idea.text = text;
    const prompt = ideaPrompt(state);
    assert.ok(prompt.startsWith(text));
    assert.equal(classifyProductionIntent(prompt).liveActionHumans, true, text);
  }
});

function count(html, pattern) {
  return (html.match(pattern) || []).length;
}

function ideaState() {
  const state = defaultEasyState();
  state.idea.text = 'A 30-second video for my bakery.';
  return state;
}

test('the idea render has one labelled textarea, templates, segments and look cards', () => {
  const html = step.render(ideaState(), facts);

  assert.equal(step.id, 'idea');
  assert.equal(step.heading, COPY.idea.heading);
  assert.equal(step.intro, COPY.idea.intro);

  assert.equal(count(html, /<textarea\b/g), 1);
  assert.match(html, /<textarea[^>]*id="easy-idea"/);
  assert.match(html, /<textarea[^>]*rows="4"/);
  assert.match(html, /<label[^>]*for="easy-idea"[^>]*>Your idea<\/label>/);

  assert.equal(count(html, /data-easy-template=/g), 4);
  assert.match(html, /<fieldset[^>]*class="easy-idea-templates"/);
  assert.match(html, /<legend[^>]*>Start from<\/legend>/);
  for (const template of COPY.idea.templates) {
    assert.match(html, new RegExp(`<label[^>]*class="easy-chip easy-idea-template"[^>]*data-easy-template="${template.id}"`));
    assert.match(html, new RegExp(`<input[^>]*type="radio"[^>]*name="easy-idea-template"[^>]*value="${template.id}"`));
    assert.ok(html.includes(template.label));
  }

  const templates = html.match(/<input[^>]*name="easy-idea-template"[^>]*>/g) || [];
  assert.equal(templates.length, 4);
  assert.equal(count(html, /<button\b/g), 0);
  assert.equal(count(html, /tabindex=/g), 0);

  const lengths = html.match(/<input[^>]*name="easy-idea-length"[^>]*>/g) || [];
  assert.equal(lengths.length, 4);
  assert.match(html, /name="easy-idea-length"[^>]*value="30"[^>]*checked/);
  for (const seconds of [15, 30, 60, 90]) {
    assert.match(html, new RegExp(`name="easy-idea-length"[^>]*value="${seconds}"`));
  }

  const shapes = html.match(/<input[^>]*name="easy-idea-shape"[^>]*>/g) || [];
  assert.equal(shapes.length, 3);
  for (const aspect of ['16:9', '9:16', '1:1']) {
    assert.ok(html.includes(`value="${aspect}"`));
  }

  const looks = html.match(/<label[^>]*data-easy-look="[^"]+"/g) || [];
  assert.equal(looks.length, 6);
  for (const id of ['clay', 'glass', 'editorial-flat', 'isometric-tech', 'paper-cut', 'cinematic-dark']) {
    assert.match(html, new RegExp(`data-easy-look="${id}"`));
    assert.ok(html.includes(COPY.idea.looks[id]));
  }

  assert.match(html, /<details[^>]*class="easy-idea-more"/);
  assert.match(html, /data-easy-references/);
  assert.match(html, /type="checkbox"[^>]*id="easy-idea-sound"[^>]*checked/);
});

test('(a) checking a template with an empty textarea applies its text with no confirm', () => {
  const template = COPY.idea.templates[0];
  const plan = templateChangePlan('', template.id, null);

  assert.ok(plan);
  assert.equal(plan.needsConfirm, false);
  assert.equal(plan.text, template.text);
  assert.equal(plan.restoreId, null);

  assert.equal(templateChangeNeedsConfirm('   ', COPY.idea.templates), false);
});

test('(b) moving between templates while the textarea holds template text needs no confirm', () => {
  const first = COPY.idea.templates[0];
  const second = COPY.idea.templates[1];
  const plan = templateChangePlan(first.text, second.id, first.id);

  assert.ok(plan);
  assert.equal(plan.needsConfirm, false);
  assert.equal(plan.text, second.text);
  assert.equal(templateChangeNeedsConfirm(first.text, COPY.idea.templates), false);
  assert.equal(templateChangeNeedsConfirm(`  ${first.text}  `, COPY.idea.templates), false);
});

test('(c) user-written text needs a confirm and cancelling restores the previous template', () => {
  const target = COPY.idea.templates[2];
  const plan = templateChangePlan('My own bakery idea', target.id, 'launch');

  assert.ok(plan);
  assert.equal(plan.needsConfirm, true);
  assert.equal(plan.text, target.text);
  assert.equal(plan.restoreId, 'launch');
  assert.equal(templateChangeNeedsConfirm('My own bakery idea', COPY.idea.templates), true);

  const withoutPrevious = templateChangePlan('My own bakery idea', target.id, null);
  assert.ok(withoutPrevious);
  assert.equal(withoutPrevious.restoreId, null);
});

test('ideaPrompt keeps the brief sentence order and skips decide answers', () => {
  const state = ideaState();
  state.questions = [
    {
      id: 'cta',
      field: 'cta',
      prompt: 'What should viewers do at the end?',
      options: ['Visit the website', 'Subscribe'],
      decide: 'none',
    },
  ];
  state.answers = { cta: 'Visit the website', audience: '__decide__' };

  const prompt = ideaPrompt(state);
  assert.match(prompt, /^A 30-second video for my bakery\. Aspect: 16:9\. Look: cinematic-dark\. Music: instrumental bed\. Finishing narration:/);
  assert.match(prompt, /Narration timing is provisional/);
  assert.match(prompt, /What should viewers do at the end\? Visit the website$/);

  state.idea.sound = false;
  assert.ok(ideaPrompt(state).includes('No music.'));
});

test('Music Video uses only the supplied song master, never automatic TTS or a music bed', () => {
  const state = ideaState();
  state.videoType = 'music-video';
  state.idea.text = 'A bold performance video for our supplied song';
  state.idea.sound = true;
  state.narration.on = true;
  const prompt = ideaPrompt(state);
  assert.match(prompt, /supplied song is the only song master/u);
  assert.match(prompt, /Do not add a narrator, narration, or any composed music substitute/u);
  assert.match(prompt, /performance is an experimental reviewed audition/u);
  assert.doesNotMatch(prompt, /Music: instrumental bed|Kokoro|Finishing narration:/u);
  assert.doesNotMatch(prompt, /detected beats|detected lyrics|perfect lip sync/iu);
});

test('Music Video brief names only LRC presentation and never serializes lyric text', () => {
  const state = ideaState();
  state.videoType = 'music-video';
  state.idea.text = 'A bold performance video for our supplied song';
  state.lyricsStyle = 'caption';
  state.lyricsLrc = '[00:01.00]Never put this private lyric in the brief';
  const caption = ideaPrompt(state);
  assert.match(caption, /separately supplied LRC uses bottom-safe caption presentation/u);
  assert.doesNotMatch(caption, /Never put this private lyric|\[00:01\.00\]/u);

  state.lyricsStyle = 'reel';
  assert.match(ideaPrompt(state), /large-overlay reel presentation/u);
  state.lyricsStyle = 'off';
  assert.doesNotMatch(ideaPrompt(state), /Never put this private lyric|caption presentation|reel presentation/u);
});

test('ideaPrompt uses the selected duration but explicit typed durations win', () => {
  const state = ideaState();
  state.idea.text = 'A warm bakery launch with a friendly ending';
  state.idea.lengthS = 60;
  assert.match(ideaPrompt(state), /Length: about 60 seconds\./u);

  state.idea.text = 'A 15-second bakery teaser with a warm ending';
  state.idea.lengthS = 90;
  const prompt = ideaPrompt(state);
  assert.match(prompt, /A 15-second bakery teaser/u);
  assert.doesNotMatch(prompt, /Length: about/u);
});

test('ideaPrompt defaults to meaningful Kokoro finishing narration without replacing native sound', () => {
  const state = ideaState();
  state.idea.text = 'A baker shapes a loaf as the morning market wakes up';
  const prompt = ideaPrompt(state);
  assert.match(prompt, /Finishing narration: meaningful scene-specific Kokoro voiceover that preserves the native soundscape\./u);
  assert.doesNotMatch(prompt, /H3|native[ -]dialogue/iu);
});

test('explicit wordless and no-speech requests suppress automatic narration guidance', () => {
  for (const text of [
    'A wordless bakery story told through hands and warm light',
    'A bakery story with no dialogue, just the morning market',
    'A bakery story with no narration please',
    'A bakery story with no speech at all',
    'A bakery story with no voiceover',
  ]) {
    const state = ideaState();
    state.idea.text = text;
    state.narration.on = true;
    const prompt = ideaPrompt(state);
    assert.ok(prompt.startsWith(text));
    assert.doesNotMatch(prompt, /Kokoro|Finishing narration:/u);
  }
});

test('silence matrix suppresses default voice and bed in every non-song mode', () => {
  for (const videoType of [null, 'motion-explainer', 'sketch-build', 'data-story', 'product-walkthrough', 'title-reveal', 'action-scene']) {
    for (const request of ['Silent', 'No audio', 'No spoken words', 'No narration', 'Wordless']) {
      const state = ideaState();
      state.videoType = videoType;
      state.idea.text = `${request}. Reveal our new identity.`;
      state.narration.on = true;
      state.idea.sound = true;
      const prompt = ideaPrompt(state);
      assert.doesNotMatch(prompt, /Kokoro|Finishing narration:|Narration timing|Music: instrumental bed/u, `${videoType}: ${request}`);
      if (['Silent', 'No audio'].includes(request)) assert.match(prompt, /Full silence: no audio/u);
      else assert.doesNotMatch(prompt, /Full silence|No music/u, 'wordless does not prohibit native sound or music');
    }
  }
});

test('wordless retains explicitly requested native sound/music and the sound-off setting', () => {
  const state = ideaState();
  state.idea.text = 'Wordless with native SFX and gentle piano music.';
  assert.match(ideaPrompt(state), /^Wordless with native SFX and gentle piano music\./u);
  assert.doesNotMatch(ideaPrompt(state), /No music|Full silence|instrumental bed|Kokoro/u);
  state.idea.sound = false;
  assert.match(ideaPrompt(state), /No music\./u);
});

test('title reveal has no default narrator, but an active spoken request is retained', () => {
  const state = ideaState();
  state.videoType = 'title-reveal';
  state.idea.text = 'Reveal our new identity with bold shapes.';
  assert.doesNotMatch(ideaPrompt(state), /Kokoro|Narration timing/u);
  assert.match(ideaPrompt(state), /No narration\./u);
  state.idea.text = 'Reveal our new identity. Narrate the company name.';
  assert.match(ideaPrompt(state), /Finishing narration:.*Kokoro/u);
  state.narration.on = false;
  assert.doesNotMatch(ideaPrompt(state), /Finishing narration:|No narration\./u);
  assert.match(ideaPrompt(state), /Narrate the company name/u);
});

test('explicit music prohibition does not suppress an active narrator', () => {
  const state = ideaState();
  state.idea.text = 'No music. A narrator explains the supplied values.';
  assert.match(ideaPrompt(state), /Finishing narration:.*Kokoro/u);
  assert.doesNotMatch(ideaPrompt(state), /Music: instrumental bed/u);
});

test('recorded Window Garden brief keeps mixed-list no-music and its exact spoken script', () => {
  const text = 'Create exactly 18 seconds of vertical 9:16 video explaining a fictional tabletop self-watering planter. Use a clear paper-cut illustration style, not photography. Show three steps: water stored below the pot; a cotton wick carrying water upward; soil receiving moisture around the roots. Use at least one meaningful ComfyUI-generated FLUX 3 Image Klein illustration visibly in the film, with native arrows or editable diagrams showing the direction. Keep the same planter design and diagram orientation across shots. Use this exact narration: Water rests below the pot. A cotton wick draws it upward. The soil receives moisture near the roots. This is a fictional design concept. Required copy, in order: RESERVOIR; COTTON WICK; ROOT ZONE. No additional on-screen copy, people, music or claims about watering frequency. Gentle motion, large readable native labels and a clear final three-second hold.';
  const spoken = 'Water rests below the pot. A cotton wick draws it upward. The soil receives moisture near the roots. This is a fictional design concept.';
  const state = defaultEasyState();
  state.videoType = 'motion-explainer';
  state.idea.text = text;
  state.idea.lengthS = 18;
  state.idea.aspect = '9:16';
  state.idea.sound = true;
  state.narration.on = true;
  const prompt = ideaPrompt(state);
  assert.ok(prompt.startsWith(`${text} Aspect: 9:16.`));
  assert.equal(prompt.split(spoken).length - 1, 1, 'all 24 spoken words remain verbatim, once');
  const suffix = prompt.slice(text.length);
  assert.match(suffix, /No music\./u);
  assert.doesNotMatch(suffix, /Music: instrumental bed|Shorten secondary wording/u);
  assert.match(suffix, /use the supplied narration verbatim with Kokoro/u);
  assert.match(suffix, /preserving its wording and sentence order across scene boundaries/u);
  assert.match(suffix, /Rebalance scene durations to give every spoken line enough time within the requested total duration/u);
  assert.match(suffix, /measured speech timing is the final authority/u);
  const intent = classifyProductionIntent(prompt, 'motion-graphics');
  assert.equal(intent.musicProhibited, true);
  assert.equal(intent.musicRequested, false);
  assert.equal(intent.wordless, false);
  assert.equal(intent.narrationRequested, true);
  assert.equal(intent.requestedSeconds, 18);
  assert.equal(intent.exactDuration, true);
});

test('exact and verbatim supplied narration never acquire permission to shorten words', () => {
  for (const text of [
    'Use this exact narration: The seed grows.',
    'Use this verbatim narration: The seed grows.',
    'Narration (verbatim): The seed grows.',
    'Read the narration verbatim: The seed grows.',
    'Use this exact spoken script: The seed grows.',
  ]) {
    const state = ideaState();
    state.idea.text = text;
    const prompt = ideaPrompt(state);
    assert.ok(prompt.startsWith(text));
    assert.match(prompt.slice(text.length), /Preserve the supplied narration verbatim\./u, text);
    assert.match(prompt, /Rebalance scene durations/u, text);
    assert.doesNotMatch(prompt, /Shorten secondary wording/u, text);
    assert.match(prompt, /Measure the actual voice before final delivery/u, text);
  }
  const state = ideaState();
  state.idea.text = 'Write narration about a seed growing, with exact timing.';
  assert.match(ideaPrompt(state), /Shorten secondary wording/u);
  assert.doesNotMatch(ideaPrompt(state), /Preserve the supplied narration verbatim/u);
});

test('exact 45-second speaking brief preserves every monologue byte and native H3 speech', () => {
  const state = ideaState();
  state.idea.text = LAST_SIGNAL_SPEAKING;
  state.idea.lengthS = 45;
  state.narration.on = true;
  const prompt = ideaPrompt(state);
  assert.ok(prompt.startsWith(LAST_SIGNAL_SPEAKING));
  const monologue = LAST_SIGNAL_SPEAKING.match(/"[^"]+"/)[0];
  assert.equal(prompt.split(monologue).length - 1, 1);
  const suffix = prompt.slice(LAST_SIGNAL_SPEAKING.length);
  assert.doesNotMatch(suffix, /Full silence|Kokoro|Finishing narration|No narration|Shorten secondary wording|Music: instrumental bed/);
  assert.match(suffix, /on-camera speaking performance and supplied lines verbatim/);
  const intent = classifyProductionIntent(prompt);
  assert.equal(intent.silent, false);
  assert.equal(intent.wordless, false);
  assert.equal(intent.speechRequested, true);
  assert.equal(intent.narrationRequested, false);
  assert.equal(intent.noCaptions, false);
  assert.equal(intent.requestedSeconds, 45);
  assert.equal(intent.exactDuration, true);
});

test('exact 45-second credits brief keeps instrumental score, native credits and no TTS', () => {
  const state = ideaState();
  state.idea.text = LAST_SIGNAL_CREDITS;
  state.idea.lengthS = 45;
  state.narration.on = true;
  const prompt = ideaPrompt(state);
  assert.ok(prompt.startsWith(LAST_SIGNAL_CREDITS));
  assert.doesNotMatch(prompt.slice(LAST_SIGNAL_CREDITS.length), /Full silence|No music|Kokoro|Finishing narration|Narration timing|Shorten secondary wording/);
  const intent = classifyProductionIntent(prompt);
  assert.equal(intent.silent, false);
  assert.equal(intent.wordless, true);
  assert.equal(intent.musicRequested, true);
  assert.equal(intent.noCaptions, false);
  assert.equal(intent.requestedSeconds, 45);
  assert.equal(intent.exactDuration, true);
});

test('quoted exact narration remains verbatim even when its words look like instructions', () => {
  const state = ideaState();
  state.idea.text = 'Use this exact narration: “Yesterday, the signal went silent. No music or speaking.” Add a piano score.';
  const prompt = ideaPrompt(state);
  assert.ok(prompt.startsWith(state.idea.text));
  assert.match(prompt.slice(state.idea.text.length), /supplied narration verbatim with Kokoro/);
  assert.doesNotMatch(prompt.slice(state.idea.text.length), /Full silence|No music|Shorten secondary wording/);
});

test('serializer keeps positive music after unrelated visual prohibitions', () => {
  for (const text of ['No people, but add music.', 'No people and use music.', 'No loud music; soft piano music.']) {
    const state = ideaState();
    state.idea.text = text;
    const suffix = ideaPrompt(state).slice(text.length);
    assert.match(suffix, /Music: instrumental bed\./u, text);
    assert.doesNotMatch(suffix, /No music\.|Full silence/u, text);
  }
});

test('narration off adds no narration only when the prompt has no speech intent', () => {
  const state = ideaState();
  state.idea.text = 'A baker shapes a loaf as the morning market wakes up';
  state.narration.on = false;
  assert.match(ideaPrompt(state), /No narration\./u);

  state.idea.text = 'A cheerful narrator introduces the morning bakery special';
  assert.doesNotMatch(ideaPrompt(state), /No narration\./u);

  state.idea.text = 'Two bakers speak on camera about their morning special';
  assert.doesNotMatch(ideaPrompt(state), /No narration\./u);

  state.idea.text = 'A wordless morning bakery story';
  assert.doesNotMatch(ideaPrompt(state), /No narration\./u);
});

test('a short idea renders the tooShort message linked by aria-describedby', () => {
  const state = ideaState();
  state.idea.text = 'Hi';
  const html = step.render(state, facts, { error: 'tooShort' });

  assert.match(html, /id="easy-idea-too-short"/);
  assert.ok(html.includes(COPY.idea.tooShort));
  assert.match(html, /<textarea[^>]*aria-describedby="[^"]*easy-idea-too-short/);
});

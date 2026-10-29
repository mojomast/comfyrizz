import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { explicitCopyContract, editorialBriefProblems, requestsRestrainedMotion } from '../src/editorial-brief-contract.mjs';
import { createCpuAgentRunner, generatedFilmCompletionProblems, motionGraphicsCompletionProblems } from '../src/agent-runner.mjs';
import { replayProvider, visiblePlateCall } from './fake-provider.mjs';

const brief = 'Required copy, in order: TIDELIGHT; A QUIETER CORNER; FICTIONAL PRODUCT CONCEPT. No narration, people, prices, specifications or performance claims. Restrained warm lighting, uncluttered composition and soft instrumental music if supported.';
// Native fields captured in product/evidence/first-pass-package.json. Keep this
// reduced fixture local: no dependency on the diagnostic run or its assets.
const captured = () => ({ motion: { energy: 'high', direction: 'left' }, scenes: [
  ['TIDELIGHT', 'cut'], ['A QUIETER CORNER', 'cut'],
  ['MATTE SEA-GREEN · BRASS · CREAM', 'zoom'], ['SMALL DOME, WARM POOL OF LIGHT', 'cut'],
  ['SET DOWN, SWITCHED ON', 'iris'], ['FICTIONAL PRODUCT CONCEPT', null],
].map(([headline, transition], index) => ({ id: `s${index + 1}`, layout: 'title', preferredFrames: 150,
  copy: { headline }, motion: { energy: 'high', entry: 'fadeUp' },
  ...(transition ? { transitionOut: { type: transition, frames: transition === 'cut' ? 0 : 10 } } : {}),
})) });
const valid = () => {
  const pkg = captured();
  for (const index of [2, 3, 4]) delete pkg.scenes[index].copy;
  return pkg;
};

test('captured six-scene native captions fail closed-copy admission without changing authored content', () => {
  const pkg = captured();
  const before = structuredClone(pkg);
  const issues = editorialBriefProblems(pkg, brief);
  assert.deepEqual(issues.map(issue => issue.code), ['BRIEF_COPY_MISMATCH']);
  for (const index of [2, 3, 4]) assert.ok(issues[0].message.includes(pkg.scenes[index].copy.headline));
  assert.deepEqual(pkg, before);
  assert.deepEqual(editorialBriefProblems(valid(), brief), []);
  assert.ok(generatedFilmCompletionProblems(pkg, { requestedSeconds: null }, 'auto', brief).some(issue => issue.startsWith('BRIEF_COPY_MISMATCH:')));
  assert.ok(motionGraphicsCompletionProblems({ package: pkg }, brief).some(issue => issue.code === 'BRIEF_COPY_MISMATCH'));
});

test('inclusive generic requests are not closed; explicit extra-copy permission wins', () => {
  for (const text of ['Must include one headline: TIDELIGHT.', 'Include TIDELIGHT and a closing disclosure.', 'Required copy: TIDELIGHT.']) {
    assert.equal(explicitCopyContract(text), null);
    assert.deepEqual(editorialBriefProblems(captured(), text), []);
  }
  assert.deepEqual(editorialBriefProblems(captured(), `${brief} Additional captions are allowed.`), []);
  assert.equal(editorialBriefProblems(captured(), `${brief} Extra copy is not allowed.`).length, 1);
  const missing = captured();
  missing.scenes[0].copy.headline = 'Something else';
  assert.match(editorialBriefProblems(missing, `${brief} You may add extra copy.`)[0].message, /missing exact copy/);
});

test('copy matching is whitespace-normalized, case/spelling exact, count-aware and ordered', () => {
  const pkg = valid();
  pkg.scenes[1].copy.headline = ' A QUIETER\n CORNER ';
  assert.deepEqual(editorialBriefProblems(pkg, brief), []);
  pkg.scenes[1].copy.headline = 'A quieter corner';
  assert.match(editorialBriefProblems(pkg, brief)[0].message, /missing exact copy.*extra native copy/);
  const swapped = valid();
  [swapped.scenes[0].copy, swapped.scenes[1].copy] = [swapped.scenes[1].copy, swapped.scenes[0].copy];
  assert.match(editorialBriefProblems(swapped, brief)[0].message, /out of scene order/);
  const duplicate = valid();
  duplicate.scenes[3].copy = { headline: 'TIDELIGHT' };
  assert.match(editorialBriefProblems(duplicate, brief)[0].message, /extra native copy/);
});

test('quoted punctuation and newlines are literal; native lower-third and drawing text are checked', () => {
  const text = 'Exact on-screen copy, in order:\n"FIRST; STILL.";\n“SECOND!”;\n\'FINISH?\'. No narration.';
  assert.deepEqual(explicitCopyContract(text), { items: ['FIRST; STILL.', 'SECOND!', 'FINISH?'], closed: true, ordered: true });
  const pkg = { scenes: [
    { id: 's1', copy: { headline: 'FIRST; STILL.' }, narration: 'not visible', notes: 'not copy' },
    { id: 's2', lower_third: { text: 'SECOND!' } },
    { id: 's3', drawing: { elements: [{ type: 'text', text: 'FINISH?' }, { type: 'path', text: 'ignored' }] } },
  ] };
  assert.deepEqual(editorialBriefProblems(pkg, text), []);
  pkg.scenes[1].lower_third.kicker = 'INVENTED';
  pkg.scenes[2].drawing.elements.push({ type: 'text', text: 'ALSO INVENTED' });
  const message = editorialBriefProblems(pkg, text)[0].message;
  assert.match(message, /lower_third.kicker/);
  assert.match(message, /drawing.elements\[2\].text/);
  assert.deepEqual(explicitCopyContract('Only on-screen copy: "DONE.".' ).items, ['DONE.']);
  assert.deepEqual(explicitCopyContract('Exact copy:\n"FIRST."\n"LAST!"\nUse calm lighting.').items, ['FIRST.', 'LAST!']);
  assert.equal(explicitCopyContract('Exact copy: "unclosed'), null);
});

test('restrained-motion detection is explicit and clause-negation aware', () => {
  for (const text of ['Restrained motion.', 'Gentle camera movement.', 'Keep animation subtle.', 'No narration; gentle motion.', 'No fast cuts, but gentle transitions.', 'Gentle motion is required.']) assert.equal(requestsRestrainedMotion(text), true, text);
  for (const text of [brief, 'Calm music and warm lighting.', 'No restrained motion.', 'Do not use gentle motion.', 'Avoid subtle animation.', 'Gentle motion is not required.', 'Motion is not restrained.', 'No desire for gentle motion.']) assert.equal(requestsRestrainedMotion(text), false, text);
});

test('drawing labels must be drawing text, not hidden layout or lower-third fields', () => {
  const text = 'Required copy, in order: RESERVOIR; COTTON WICK; ROOT ZONE.';
  const pkg = { scenes: ['RESERVOIR', 'COTTON WICK', 'ROOT ZONE'].map((label, index) => ({
    id: `s${index}`, layout: 'list', copy: { headline: label }, lower_third: { text: label },
    drawing: { elements: [{ type: 'path', points: [[500, 800], [500, 400]] }] },
  })) };
  const problems = editorialBriefProblems(pkg, text);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /missing exact copy.*RESERVOIR.*COTTON WICK.*ROOT ZONE/);
  assert.match(problems[0].message, /Drawing scenes render only drawing.elements text/);
  assert.match(problems[0].message, /never use an empty or whitespace headline/i);
  for (const scene of pkg.scenes) scene.drawing.elements.push({ type: 'text', text: scene.lower_third.text });
  assert.deepEqual(editorialBriefProblems(pkg, text), [], 'hidden metadata does not duplicate visible drawing labels');
});

test('media-only layout copy cannot satisfy required visible text but its lower third can', () => {
  const pkg = { scenes: [{ id: 's1', layout: 'list', media_only: true, copy: { headline: 'VISIBLE' } }] };
  assert.match(editorialBriefProblems(pkg, 'Exact copy: VISIBLE.')[0].message, /missing exact copy/);
  pkg.scenes[0].lower_third = { text: 'VISIBLE' };
  assert.deepEqual(editorialBriefProblems(pkg, 'Exact copy: VISIBLE.'), []);
});

test('duplicate-copy repair identifies the optional opening kicker rather than cycling the closing headline', () => {
  const pkg = { scenes: [
    { id: 'opening', layout: 'title', copy: { headline: 'MORNING STILL', kicker: 'A SMALL PAUSE' } },
    { id: 'closing', layout: 'title', copy: { headline: 'A SMALL PAUSE' } },
  ] };
  const brief = 'Required copy, in order: MORNING STILL; A SMALL PAUSE.';
  const problems = editorialBriefProblems(pkg, brief);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /occurs 2 times/);
  assert.match(problems[0].message, /Preserve the existing headline occurrence\(s\) and clear the duplicate optional fields \["scenes\[0\]\(opening\).copy.kicker"\] with empty strings/);
  pkg.scenes[0].copy.kicker = '';
  assert.deepEqual(editorialBriefProblems(pkg, brief), []);
});

test('explicit restrained portrait motion rejects high energy and non-calm transitions, with editable scene overrides', () => {
  const pkg = captured();
  const text = 'A landscape documentary portrait with restrained motion.';
  const issues = editorialBriefProblems(pkg, text);
  assert.equal(issues.length, 6);
  assert.ok(issues.every(issue => issue.code === 'BRIEF_MOTION_MISMATCH'));
  assert.match(issues[2].message, /zoom/);
  assert.match(issues[4].message, /iris/);
  for (const scene of pkg.scenes) scene.motion.energy = 'calm';
  assert.equal(editorialBriefProblems(pkg, text).length, 2, 'low energy alone cannot excuse zoom/iris');
  for (const [index, scene] of pkg.scenes.entries()) scene.transitionOut = { type: ['none', 'cut', 'fade', 'blur', 'paper-reveal', 'draw-reveal'][index] };
  assert.deepEqual(editorialBriefProblems(pkg, text), [], 'scene overrides repair inherited package high energy');
});

for (const repairSucceeds of [false, true]) {
  test(`real completion loop ${repairSucceeds ? 'accepts corrected copy' : 'rejects unchanged extra copy'} after one bounded repair`, async t => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'editorial-brief-'));
    const prompt = 'A motion-graphics title. Exact copy: TIDELIGHT. No narration.';
    const calls = [
      { name: 'storyboard.propose', args: { brief: prompt, scenes: [{ id: 's_title', layout: 'title', preferredFrames: 90, copy: { headline: 'TIDELIGHT', sub: 'INVENTED' } }] } },
      { name: 'assets.generate_image', args: { scene_id: 's_title', kind: 'illustration', intent: 'An editorial desk lamp backdrop' } },
      visiblePlateCall('s_title'),
      null,
      ...(repairSucceeds ? [{ name: 'storyboard.edit', args: { scene_id: 's_title', patch: { copy: { headline: 'TIDELIGHT', sub: '' } } } }] : []),
    ];
    const provider = await replayProvider(calls);
    t.after(async () => { await provider.close(); rmSync(runtimeDir, { recursive: true, force: true }); });
    const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
    const events = [];
    const run = runner({ brief: prompt, provider: 'custom', onEvent: event => events.push(event) });
    if (repairSucceeds) {
      const result = await run;
      assert.deepEqual(editorialBriefProblems(result.package, prompt), []);
      assert.equal(result.package.scenes[0].copy.headline, 'TIDELIGHT');
    } else {
      await assert.rejects(run, error => error.status === 422 && error.code === 'MOTION_GRAPHICS_INCOMPLETE' && /BRIEF_COPY_MISMATCH/.test(error.message));
    }
    assert.equal(events.filter(event => event.type === 'runner_phase' && event.phase === 'repair' && event.status === 'started').length, 1);
    const repairRequest = provider.requests[4];
    assert.match(JSON.stringify(repairRequest.messages.filter(message => message.role === 'user')), /BRIEF_COPY_MISMATCH/);
    assert.doesNotMatch(JSON.stringify(repairRequest.messages.filter(message => message.role === 'system')), /INVENTED/);
    assert.equal(provider.requests.length, repairSucceeds ? 6 : 5);
  });
}

for (const repairSucceeds of [false, true]) {
  test(`motion completion ${repairSucceeds ? 'accepts a calm scene override' : 'rejects uncorrected high energy'} after bounded repair`, async t => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'editorial-motion-'));
    const prompt = 'A motion-graphics title with restrained motion. No narration.';
    const calls = [
      { name: 'storyboard.propose', args: { brief: prompt, motion: { energy: 'high' }, scenes: [{ id: 's_title', layout: 'title', preferredFrames: 90, copy: { headline: 'THE NIGHT BAKER' }, motion: { energy: 'high' } }] } },
      { name: 'assets.generate_image', args: { scene_id: 's_title', kind: 'illustration', intent: 'A quiet bakery backdrop' } },
      visiblePlateCall('s_title'), null,
      ...(repairSucceeds ? [{ name: 'storyboard.edit', args: { scene_id: 's_title', patch: { motion: { energy: 'calm' } } } }] : []),
    ];
    const provider = await replayProvider(calls);
    t.after(async () => { await provider.close(); rmSync(runtimeDir, { recursive: true, force: true }); });
    const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
    const run = runner({ brief: prompt, provider: 'custom' });
    if (repairSucceeds) {
      const result = await run;
      assert.equal(result.package.motion.energy, 'high');
      assert.equal(result.package.scenes[0].motion.energy, 'calm');
      assert.deepEqual(editorialBriefProblems(result.package, prompt), []);
    } else {
      await assert.rejects(run, error => error.status === 422 && /BRIEF_MOTION_MISMATCH/.test(error.message));
    }
    assert.equal(provider.requests.length, repairSucceeds ? 6 : 5);
    assert.match(JSON.stringify(provider.requests[4].messages.filter(message => message.role === 'user')), /BRIEF_MOTION_MISMATCH/);
  });
}

const panelBrief = 'Only on-screen copy: BEFORE; AFTER. Place BEFORE over the left panel and AFTER over the right as native text; the generated images must contain no lettering.';
// Reduced native shape from desk-reset/evidence/first-pass-package.json.
const deskReset = () => ({ format: { width: 1920, height: 1080, fps: 30 }, scenes: [{
  id: 's1', layout: 'compare', preferredFrames: 360,
  copy: { headline: 'BEFORE' }, lower_third: { text: 'AFTER' },
  media: [{ asset: 'a_img_a2fa2e49ccd44f42' }, { asset: 'a_img_b9b0f747ba68f808' }],
}] });
const labeledDeskReset = () => {
  const pkg = deskReset();
  pkg.scenes[0].copy.headline = '';
  delete pkg.scenes[0].lower_third;
  pkg.scenes[0].media[0].label = 'BEFORE';
  pkg.scenes[0].media[1].label = 'AFTER';
  return pkg;
};
const placementProblems = (pkg, text = panelBrief) => editorialBriefProblems(pkg, text).filter(issue => issue.code === 'BRIEF_COPY_PLACEMENT');

test('captured desk-reset global text fails spatial association; moving it to native panel labels satisfies both gates', () => {
  const pkg = deskReset();
  const before = structuredClone(pkg);
  const issues = editorialBriefProblems(pkg, panelBrief);
  assert.deepEqual(issues.map(issue => issue.code), ['BRIEF_COPY_PLACEMENT']);
  assert.match(issues[0].message, /media\[\]\.label/);
  assert.match(issues[0].message, /preserving each asset, fit, frame/);
  assert.match(issues[0].message, /copy patches merge/);
  assert.deepEqual(pkg, before);
  const corrected = labeledDeskReset();
  corrected.scenes[0].media[0].fit = 'contain';
  corrected.scenes[0].media[1].frame = 'none';
  const correctedBefore = structuredClone(corrected);
  assert.deepEqual(editorialBriefProblems(corrected, panelBrief), []);
  assert.deepEqual(corrected, correctedBefore);
  corrected.scenes[0].copy.headline = 'BEFORE';
  assert.deepEqual(editorialBriefProblems(corrected, panelBrief).map(issue => issue.code), ['BRIEF_COPY_MISMATCH'], 'moving labels must not leave duplicate global text');
});

test('panel association rejects swaps, missing labels, hidden panels and non-comparison layouts', () => {
  for (const change of [
    scene => { [scene.media[0].label, scene.media[1].label] = [scene.media[1].label, scene.media[0].label]; },
    scene => { delete scene.media[0].label; scene.copy.headline = 'BEFORE'; },
    scene => { scene.media_only = true; },
    scene => { scene.drawing = { elements: [] }; },
    scene => { scene.composition = { elements: [] }; },
    scene => { scene.layout = 'hero'; },
    scene => { scene.media.pop(); },
  ]) {
    const pkg = labeledDeskReset();
    change(pkg.scenes[0]);
    assert.equal(placementProblems(pkg).length, 1);
  }
  const split = labeledDeskReset();
  split.scenes[0].layout = 'split';
  assert.deepEqual(editorialBriefProblems(split, panelBrief), []);
});

test('physical panel mapping follows the renderer aspect threshold and does not reinterpret left/right as top/bottom', () => {
  const pkg = labeledDeskReset();
  pkg.format = { width: 1080, height: 1920, fps: 30 };
  const stackedBrief = panelBrief.replace('left panel', 'top panel').replace('right as', 'bottom as');
  assert.deepEqual(editorialBriefProblems(pkg, stackedBrief), []);
  assert.match(placementProblems(pkg)[0].message, /media\[0\] top and media\[1\] bottom/);
  assert.match(placementProblems(pkg)[0].message, /merely swapping labels cannot fix/);
  [pkg.scenes[0].media[0].label, pkg.scenes[0].media[1].label] = ['AFTER', 'BEFORE'];
  assert.equal(placementProblems(pkg, stackedBrief).length, 1);
  pkg.scenes[0].media[0].label = 'BEFORE';
  pkg.scenes[0].media[1].label = 'AFTER';
  pkg.format = { width: 1000, height: 1200, fps: 30 };
  assert.deepEqual(editorialBriefProblems(pkg, panelBrief), [], 'threshold is strictly greater than 1.2');
  pkg.format.height = 1201;
  assert.equal(placementProblems(pkg).length, 1);
  pkg.format = { width: 1920, height: 1080, fps: 30 };
  assert.equal(placementProblems(pkg, stackedBrief).length, 1);
});

test('only literal placement imperatives create spatial contracts; descriptions and negated requests do not', () => {
  for (const text of [
    'Only on-screen copy: BEFORE; AFTER. Left: a cluttered desk. Right: a tidy desk.',
    'Only on-screen copy: BEFORE; AFTER. Use a headline and a lower-third label.',
    'Only on-screen copy: BEFORE; AFTER. Do not place BEFORE over the left panel.',
    'Only on-screen copy: BEFORE; AFTER. We could place BEFORE over the left panel.',
    'Only on-screen copy: BEFORE; AFTER. Place BEFORE over the left panel if useful.',
    'Only on-screen copy: BEFORE; AFTER. Place BEFORE over the left panel as native text if useful.',
    'Only on-screen copy: BEFORE; AFTER. Place UNKNOWN over the left panel.',
    'Place BEFORE over the left panel and AFTER over the right panel.',
  ]) assert.deepEqual(placementProblems(deskReset(), text), [], text);
  assert.equal(placementProblems(deskReset(), 'Only on-screen copy: BEFORE; AFTER. Place BEFORE on the left panel. Place AFTER on the right panel.').length, 1);
});

test('placement literals preserve quoted punctuation and regex metacharacters with whitespace normalization', () => {
  const text = 'Exact copy: "BEFORE (v1)+[x]?"; "AFTER.*$!". Place "BEFORE (v1)+[x]?" on the left panel and "AFTER.*$!" on the right panel as native text.';
  const pkg = labeledDeskReset();
  pkg.scenes[0].media[0].label = 'BEFORE\n(v1)+[x]?';
  pkg.scenes[0].media[1].label = 'AFTER.*$!';
  assert.deepEqual(editorialBriefProblems(pkg, text), []);
  [pkg.scenes[0].media[0].label, pkg.scenes[0].media[1].label] = [pkg.scenes[0].media[1].label, pkg.scenes[0].media[0].label];
  assert.deepEqual(editorialBriefProblems(pkg, text).map(issue => issue.code), ['BRIEF_COPY_PLACEMENT']);
});

test('required panel labels must coexist in one comparison rather than separate scenes', () => {
  const pkg = labeledDeskReset();
  const second = structuredClone(pkg.scenes[0]);
  second.id = 's2';
  delete pkg.scenes[0].media[1].label;
  delete second.media[0].label;
  pkg.scenes.push(second);
  assert.deepEqual(editorialBriefProblems(pkg, panelBrief).map(issue => issue.code), ['BRIEF_COPY_PLACEMENT']);
});

for (const repairSucceeds of [false, true]) {
  test(`panel placement completion ${repairSucceeds ? 'accepts a native plate-label repair' : 'rejects unchanged global copy'} after one bounded repair`, async t => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'editorial-placement-'));
    const prompt = `A motion-graphics comparison. ${panelBrief} No narration.`;
    let media;
    const attachPlates = request => {
      const results = request.messages.filter(message => message.role === 'tool').map(message => {
        try { const body = JSON.parse(message.content); return body.result ?? body; } catch { return null; }
      });
      const ids = [...new Set(results.filter(result => result?.asset?.id).map(result => result.asset.id))];
      assert.equal(ids.length, 2);
      media = ids.map(asset => ({ asset }));
      return { name: 'storyboard.edit', args: { scene_id: 's_compare', patch: { media, foreground: [] } } };
    };
    const calls = [
      { name: 'storyboard.propose', args: { brief: prompt, scenes: [{ id: 's_compare', layout: 'compare', preferredFrames: 90, copy: { headline: 'BEFORE' }, lower_third: { text: 'AFTER' } }] } },
      { name: 'assets.generate_image', args: { scene_id: 's_compare', kind: 'illustration', intent: 'A cluttered oak desk with loose papers' } },
      { name: 'assets.generate_image', args: { scene_id: 's_compare', kind: 'illustration', intent: 'The same oak desk tidied with stacked papers' } },
      attachPlates, null,
      ...(repairSucceeds ? [() => ({ name: 'storyboard.edit', args: { scene_id: 's_compare', patch: { media: media.map((plate, index) => ({ ...plate, label: index === 0 ? 'BEFORE' : 'AFTER' })), copy: null, lower_third: null } } })] : []),
    ];
    const provider = await replayProvider(calls);
    t.after(async () => { await provider.close(); rmSync(runtimeDir, { recursive: true, force: true }); });
    const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
    const events = [];
    const run = runner({ brief: prompt, provider: 'custom', onEvent: event => events.push(event) });
    if (repairSucceeds) {
      const result = await run;
      assert.deepEqual(editorialBriefProblems(result.package, prompt), []);
      assert.deepEqual(result.package.scenes[0].media.map(plate => plate.asset), media.map(plate => plate.asset));
      assert.deepEqual(result.package.scenes[0].media.map(plate => plate.label), ['BEFORE', 'AFTER']);
      assert.equal(result.package.scenes[0].lower_third, undefined);
    } else {
      await assert.rejects(run, error => error.status === 422 && /BRIEF_COPY_PLACEMENT/.test(error.message));
    }
    assert.equal(events.filter(event => event.type === 'runner_phase' && event.phase === 'repair' && event.status === 'started').length, 1);
    assert.match(JSON.stringify(provider.requests[5].messages.filter(message => message.role === 'user')), /BRIEF_COPY_PLACEMENT/);
    assert.equal(provider.requests.length, repairSucceeds ? 7 : 6);
  });
}

const morningBrief = 'Create exactly 12 seconds of landscape video called MORNING STILL. Use one meaningful full-frame ComfyUI-generated FLUX 3 Image Klein photograph of a cream ceramic cup on an oak windowsill in soft morning light, with no people or lettering in the image. Keep that one photograph static and visible throughout. Use restrained native text entrances and a completely still final three-second hold. Required copy, in order: MORNING STILL; A SMALL PAUSE. Render those exact words as native text, without any additional captions. No narration, dialogue, music or sound effects; the video must be silent. Aspect: 16:9. Look: cinematic-dark. Full silence: no audio, music, sound effects or speech.';
const morningImage = 'a_img_2d1ca0e7e438a7c8';
// Reduced original revision-5 shape from review-return-fixed/evidence/
// response-1793305333709.json, not the subsequently duplicated revision 6.
const morningStill = () => ({
  format: { width: 1920, height: 1080, fps: 30 }, duration: { mode: 'target', targetFrames: 360, exact: true },
  assets: { [morningImage]: { kind: 'image', origin: 'generated', status: 'pending', gen: {
    generator: 'flux3-klein', workflow: 'workflows/flux3_klein_t2i.api.json', inputs: { prompt: 'A cream ceramic cup on an oak windowsill', width: 1920, height: 1080 },
  } } },
  scenes: [
    { id: 's1', layout: 'title', variant: 'centered', preferredFrames: 216, copy: { headline: 'MORNING STILL' }, background: { asset: morningImage }, foreground: [] },
    { id: 's2', layout: 'title', variant: 'outro', preferredFrames: 90, copy: { headline: 'A SMALL PAUSE' }, foreground: [] },
  ],
});
const continuousProblems = (pkg, text = morningBrief) => editorialBriefProblems(pkg, text).filter(issue => issue.code === 'BRIEF_IMAGE_CONTINUITY');

test('original MORNING STILL closing scene fails continuous-image admission; reusing its pending background satisfies the contract', () => {
  const pkg = morningStill();
  const original = structuredClone(pkg);
  const issues = editorialBriefProblems(pkg, morningBrief);
  assert.deepEqual(issues.map(issue => issue.code), ['BRIEF_IMAGE_CONTINUITY']);
  assert.equal(issues[0].path, 'scenes[1].background');
  assert.match(issues[0].message, /s2:.*background.asset/);
  assert.ok(issues[0].message.includes(morningImage));
  assert.match(issues[0].message, /do not generate another image/);
  assert.deepEqual(pkg, original, 'admission never rewrites authored scenes');
  pkg.scenes[1].background = { asset: morningImage };
  assert.deepEqual(editorialBriefProblems(pkg, morningBrief), []);
  assert.deepEqual(pkg.scenes.map(scene => [scene.copy, scene.preferredFrames]), original.scenes.map(scene => [scene.copy, scene.preferredFrames]));
  assert.equal(Object.keys(pkg.assets).length, 1);
});

test('continuous-image identity uses the shared asset ID rather than matching prompts or hashes', () => {
  const pkg = morningStill();
  pkg.assets.a_other = structuredClone(pkg.assets[morningImage]);
  pkg.scenes[1].background = { asset: 'a_other' };
  assert.match(continuousProblems(pkg)[0].message, /different image "a_other"/);
  pkg.scenes[1].background.asset = morningImage;
  assert.deepEqual(continuousProblems(pkg), [], 'an unused other asset does not change which background is used throughout');
});

test('unused image references and replaced backgrounds cannot satisfy whole-film image visibility', () => {
  for (const change of [
    scene => { scene.media = [{ asset: morningImage }]; },
    scene => { scene.foreground = [{ asset: morningImage, x: 0.5, y: 0.5, w: 1, h: 1, anim: 'none' }]; },
    scene => { scene.notes = `Reuse ${morningImage}`; },
    scene => { scene.background = { asset: morningImage, procedural: { pattern: 'solid' } }; },
    scene => { scene.background = { asset: morningImage }; scene.drawing = { elements: [] }; },
    scene => { scene.background = { asset: morningImage }; scene.composition = { elements: [] }; },
    scene => { scene.background = { asset: morningImage }; scene.layout = 'compare'; scene.media = [{ asset: morningImage }, { asset: morningImage }]; },
  ]) {
    const pkg = morningStill();
    change(pkg.scenes[1]);
    assert.equal(continuousProblems(pkg).length, 1, JSON.stringify(pkg.scenes[1]));
  }
});

test('continuous backgrounds accept planned or ready images but not unresolved or video bindings', () => {
  const pkg = morningStill();
  pkg.scenes[1].background = { asset: morningImage };
  assert.deepEqual(continuousProblems(pkg), []);
  pkg.assets[morningImage].status = 'ready';
  pkg.assets[morningImage].file = 'assets/morning.png';
  assert.deepEqual(continuousProblems(pkg), []);
  pkg.scenes[1].background.asset = 'a_unresolved';
  assert.equal(continuousProblems(pkg).length, 1);
  pkg.assets.a_unresolved = { kind: 'video', status: 'pending' };
  assert.equal(continuousProblems(pkg).length, 1);
});

test('generic supporting-image and video requests do not acquire a continuous-image contract', () => {
  for (const text of [
    'Use one meaningful ComfyUI-generated illustration to support a data story and its charts.',
    'Use one full-frame photograph of a cup, followed by a chart.',
    'Use one photograph. Keep that one photograph static and visible throughout.',
    'Use one full-frame photograph. Keep that one photograph visible throughout the opening scene.',
    'Use one full-frame video. Keep that one video static and visible throughout.',
    'Do not use one full-frame photograph. Keep that one photograph visible throughout.',
    'Use one full-frame photograph. Do not keep that one photograph visible throughout.',
  ]) assert.deepEqual(continuousProblems(morningStill(), text), [], text);
});

test('continuous-image grammar supports explicit whole-film variants and abstains on later exceptions', () => {
  for (const text of [
    'Use a single full-frame photo. Keep the same photo visible end-to-end.',
    'Use the same full-frame image. Keep that image visible for the entire film.',
    'Use one full-frame still. Keep this one still static and visible throughout the whole video.',
  ]) assert.equal(continuousProblems(morningStill(), text).length, 1, text);
  for (const text of [
    `${morningBrief} Then switch to a black closing card.`,
    'Use one full-frame photograph until the last scene. Keep that one photograph visible throughout.',
    'Use one full-frame photograph. Keep that one photograph visible throughout, except the outro.',
    `${morningBrief} End with a blank frame.`,
    `${morningBrief} Replace the photograph in the closing scene.`,
  ]) assert.deepEqual(continuousProblems(morningStill(), text), [], text);
});

for (const repairSucceeds of [false, true]) {
  test(`continuous-image completion ${repairSucceeds ? 'reuses the one image in the closing scene' : 'rejects the missing closing image'} after bounded repair`, async t => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'editorial-continuous-image-'));
    let imageId;
    let initialImageResults;
    const attachOpening = request => {
      initialImageResults = request.messages.filter(message => message.role === 'tool').flatMap(message => {
        try { const body = JSON.parse(message.content); const result = body.result ?? body; return result?.asset?.id ? [result.asset.id] : []; } catch { return []; }
      });
      assert.equal(initialImageResults.length, 1);
      const call = visiblePlateCall('s1')(request);
      imageId = call.args.patch.background.asset;
      return call;
    };
    const scenes = morningStill().scenes.map(({ background, ...scene }) => scene);
    const calls = [
      { name: 'storyboard.propose', args: { brief: morningBrief, title: 'MORNING STILL', scenes } },
      { name: 'assets.generate_image', args: { scene_id: 's1', kind: 'illustration', intent: 'One static photograph of a cream ceramic cup on an oak windowsill in soft morning light' } },
      attachOpening, null,
      ...(repairSucceeds ? [() => ({ name: 'storyboard.edit', args: { scene_id: 's2', patch: { background: { asset: imageId } } } })] : []),
    ];
    const provider = await replayProvider(calls);
    t.after(async () => { await provider.close(); rmSync(runtimeDir, { recursive: true, force: true }); });
    const runner = createCpuAgentRunner({ runtimeDir, providers: { custom: { baseUrl: provider.url } } });
    const events = [];
    const run = runner({ brief: morningBrief, motionModel: 'klein', provider: 'custom', onEvent: event => events.push(event) });
    if (repairSucceeds) {
      const result = await run;
      assert.deepEqual(editorialBriefProblems(result.package, morningBrief), []);
      assert.deepEqual(result.package.scenes.map(scene => scene.background?.asset), [imageId, imageId]);
      assert.deepEqual(result.package.scenes.map(scene => scene.copy.headline), ['MORNING STILL', 'A SMALL PAUSE']);
      assert.deepEqual(result.package.scenes.map(scene => scene.preferredFrames), scenes.map(scene => scene.preferredFrames));
      assert.equal(result.pendingGpu.length, 1, 'repair reuses one image job rather than generating a closing image');
      assert.deepEqual(Object.keys(result.package.assets).filter(id => result.package.assets[id].kind === 'image'), initialImageResults);
    } else {
      await assert.rejects(run, error => error.status === 422 && /BRIEF_IMAGE_CONTINUITY/.test(error.message));
    }
    assert.equal(events.filter(event => event.type === 'runner_phase' && event.phase === 'repair' && event.status === 'started').length, 1);
    const repairRequest = provider.requests[4];
    assert.match(JSON.stringify(repairRequest.messages.filter(message => message.role === 'user')), /BRIEF_IMAGE_CONTINUITY/);
    assert.match(JSON.stringify(repairRequest.messages.filter(message => message.role === 'user')), /do not generate another image/);
    assert.equal(provider.requests.length, repairSucceeds ? 6 : 5);
  });
}

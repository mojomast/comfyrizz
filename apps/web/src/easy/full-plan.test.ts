// Pure full-plan tests: no DOM, network, provider, credentials or paid work.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyFullPlanFields,
  fullPlanMarkup,
  fullPlanProposalScope,
} from './full-plan.ts';

function fixture() {
  return {
    schemaVersion: 1,
    revision: 7,
    id: 'pkg_fullplan',
    title: 'Rain & <script>alert("title")</script>',
    proposal: {
      logline: 'A shopkeeper <finds> an umbrella.',
      look: 'Clay & rain "at night"',
      soundtrack: "Felt piano's rain",
    },
    format: { width: 1920, height: 1080, fps: 30 },
    scenes: [{
      id: 'shot-1',
      layout: 'title',
      preferredFrames: 180,
      copy: {
        kicker: 'Closing <time>',
        headline: 'The last "umbrella"',
        sub: 'One left & one returned',
        body: 'A body with </textarea><script>alert("copy")</script>',
        quote: 'Keep the river <moving>',
        attribution: 'The cartographer',
        cta: 'Watch the restoration',
        footnote: 'Paid > forward',
        items: ['Borrow <one>', 'Return & repeat'],
      },
      narration: 'She opens the door <softly>.',
      narration_text: 'She opens the door <softly>.',
      notes: 'Rain on the lens & practical light.',
      visualDirection: 'Slow push > toward the counter.',
      transitionOut: { type: 'fade', frames: 12 },
    }],
    assets: {
      a_vid_1: {
        kind: 'video',
        status: 'pending',
        origin: 'generated',
        gen: {
          generator: 'fasth3-omni',
          inputs: {
            prompt: 'A <yellow> umbrella & a shopkeeper',
            negative: 'No text <or> logos',
            finishing_sound: 'Rain + bell in finishing',
            style: 'Cinematic & quiet',
            plan: 'Rain, umbrella fabric and a bell',
            seed: 4101,
          },
          direction: {
            subject: 'The <shopkeeper>',
            composition: 'Umbrella left & counter right',
            action: 'She > folds the umbrella',
            camera: 'Medium "push"',
            soundscape: 'Rain & paper',
            non_diegetic_music: 'No score <yet>',
            dialogue: {
              text: 'We close at nine.',
              conditioningText: 'We close at nine.',
              language: 'en',
              voice: 'A warm, quiet shopkeeper',
              delivery: 'Softly, without rushing',
            },
          },
          finishing_sound: 'Felt piano & rain',
        },
        file: 'assets/a_vid_1.mp4',
      },
    },
    compliance: { open_weights_only: true },
  };
}

function planCard() {
  return {
    schema: 'comfyrizz.plan-card/v1',
    kind: 'plan',
    planId: 'plan_1',
    planHash: 'server-signed-hash-stays-in-the-snapshot',
    reservationCeiling: 12,
    collectAndStopReserve: 1,
    actions: [{
      id: 'act_shot_1',
      kind: 'shot.generate',
      targetId: 'shot-1',
      takes: 3,
      upperBound: 4,
      assetIds: ['a_vid_1', 'a_img_2'],
    }],
  };
}

test('fullPlanMarkup renders overview, every scene field, generation fields and read-only GPU details', () => {
  const html = fullPlanMarkup(fixture(), planCard());

  for (const label of ['Overview', 'Scenes', 'Generation assets', 'GPU actions &amp; cost']) {
    assert.ok(html.includes(label), `missing section ${label}`);
  }
  for (const path of [
    '/title',
    '/proposal/logline',
    '/proposal/look',
    '/proposal/soundtrack',
    '/scenes/0/copy/headline',
    '/scenes/0/copy/sub',
    '/scenes/0/copy/body',
    '/scenes/0/copy/kicker',
    '/scenes/0/copy/quote',
    '/scenes/0/copy/attribution',
    '/scenes/0/copy/cta',
    '/scenes/0/copy/footnote',
    '/scenes/0/copy/items',
    '/scenes/0/narration',
    '/scenes/0/narration_text',
    '/scenes/0/notes',
    '/scenes/0/visualDirection',
    '/assets/a_vid_1/gen/inputs/prompt',
    '/assets/a_vid_1/gen/inputs/negative',
    '/assets/a_vid_1/gen/inputs/finishing_sound',
    '/assets/a_vid_1/gen/inputs/style',
    '/assets/a_vid_1/gen/inputs/plan',
    '/assets/a_vid_1/gen/direction/subject',
    '/assets/a_vid_1/gen/direction/composition',
    '/assets/a_vid_1/gen/direction/action',
    '/assets/a_vid_1/gen/direction/camera',
    '/assets/a_vid_1/gen/direction/soundscape',
    '/assets/a_vid_1/gen/direction/non_diegetic_music',
    '/assets/a_vid_1/gen/direction/dialogue/text',
    '/assets/a_vid_1/gen/direction/dialogue/conditioningText',
    '/assets/a_vid_1/gen/direction/dialogue/language',
    '/assets/a_vid_1/gen/direction/dialogue/voice',
    '/assets/a_vid_1/gen/direction/dialogue/delivery',
    '/assets/a_vid_1/gen/finishing_sound',
  ]) {
    assert.ok(html.includes(`data-full-plan-path="${path}"`), `missing editor ${path}`);
  }

  assert.match(html, /<details class="easy-full-plan-card easy-full-plan-scene" open>/);
  assert.match(html, /<details class="easy-full-plan-card easy-full-plan-asset">/);
  assert.match(html, /Borrow &lt;one&gt;\nReturn &amp; repeat/);
  assert.match(html, /Reservation ceiling:<\/strong> 12 units/);
  assert.match(html, /Collect-and-stop reserve:<\/strong> 1 units/);
  assert.match(html, /<dt>Kind<\/dt><dd>shot.generate<\/dd>/);
  assert.match(html, /<dt>Target<\/dt><dd>shot-1<\/dd>/);
  assert.match(html, /<dt>Takes<\/dt><dd>3<\/dd>/);
  assert.match(html, /<dt>Upper bound<\/dt><dd>4<\/dd>/);
  assert.match(html, /<dt>Asset IDs<\/dt><dd>a_vid_1, a_img_2<\/dd>/);
  assert.match(html, /<summary>Full signed plan JSON <span>Read only<\/span><\/summary>/);
  assert.match(html, /<summary>Full package JSON <span>Read only<\/span><\/summary>/);
  assert.match(html, /data-full-plan-save>Save &amp; re-sign plan/);
  assert.doesNotMatch(html, /data-full-plan-repropose/);
  assert.match(html, /data-full-plan-cancel/);
  assert.match(html, /aria-label="Close full plan editor"/);
});

test('fullPlanMarkup escapes creative text, attributes, GPU values and transparent JSON', () => {
  const pkg = fixture();
  pkg.assets['a_vid_1'].gen.direction.camera = 'Wide <img src=x onerror=alert(1)>';
  const card = planCard();
  card.actions[0].targetId = 'shot"><script>alert("gpu")</script>';
  const html = fullPlanMarkup(pkg, card);

  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.ok(html.includes('Rain &amp; &lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;'));
  assert.ok(html.includes('A body with &lt;/textarea&gt;&lt;script&gt;'));
  assert.ok(html.includes('Wide &lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('shot&quot;&gt;&lt;script&gt;'));
  assert.ok(html.includes('A shopkeeper &lt;finds&gt; an umbrella.'));
});

test('asset controls are rendered only when present while core creative fields can start blank', () => {
  const html = fullPlanMarkup({
    id: 'pkg_minimal',
    revision: 1,
    title: '',
    scenes: [{ id: 's1', copy: {} }],
    assets: {
      a_prompt_only: { kind: 'image', gen: { inputs: { prompt: '' } } },
      a_plain: { kind: 'svg' },
    },
  });

  for (const path of ['/proposal/logline', '/proposal/look', '/proposal/soundtrack', '/scenes/0/copy/body', '/scenes/0/narration']) {
    assert.ok(html.includes(`data-full-plan-path="${path}"`));
  }
  assert.ok(html.includes('data-full-plan-path="/assets/a_prompt_only/gen/inputs/prompt"'));
  assert.ok(!html.includes('/assets/a_prompt_only/gen/inputs/negative'));
  assert.ok(!html.includes('/assets/a_prompt_only/gen/direction/subject'));
  assert.ok(!html.includes('/assets/a_prompt_only/gen/finishing_sound'));
  assert.match(html, /This asset has no editable generation directions\./);
});

test('applyFullPlanFields edits a deep clone, preserves unrelated data and converts item lines', () => {
  const pkg = fixture();
  const before = JSON.stringify(pkg);
  const edited = applyFullPlanFields(pkg, {
    '/title': 'A new title',
    '/scenes/0/copy/body': 'Updated body',
    '/scenes/0/copy/items': ' First item\nSecond & item\n\n',
    '/scenes/0/notes': 'New visual notes',
    '/assets/a_vid_1/gen/inputs/prompt': 'Updated prompt',
    '/assets/a_vid_1/gen/direction/camera': 'Static wide',
    '/assets/a_vid_1/gen/direction/dialogue/text': 'We close at ten.',
    '/assets/a_vid_1/gen/inputs/plan': 'Rain and a single closing bell',
  });

  assert.equal(JSON.stringify(pkg), before, 'the source package is untouched');
  assert.notEqual(edited, pkg);
  assert.notEqual(edited.scenes[0], pkg.scenes[0]);
  assert.notEqual(edited.assets.a_vid_1.gen, pkg.assets.a_vid_1.gen);
  assert.equal(edited.title, 'A new title');
  assert.equal(edited.scenes[0].copy.body, 'Updated body');
  assert.deepEqual(edited.scenes[0].copy.items, ['First item', 'Second & item']);
  assert.equal(edited.scenes[0].notes, 'New visual notes');
  assert.equal(edited.assets.a_vid_1.gen.inputs.prompt, 'Updated prompt');
  assert.equal(edited.assets.a_vid_1.gen.direction.camera, 'Static wide');
  assert.equal(edited.assets.a_vid_1.gen.direction.dialogue.text, 'We close at ten.');
  assert.equal(edited.assets.a_vid_1.gen.direction.dialogue.conditioningText, pkg.assets.a_vid_1.gen.direction.dialogue.conditioningText);
  assert.equal(edited.assets.a_vid_1.gen.inputs.plan, 'Rain and a single closing bell');
  assert.equal(edited.scenes[0].copy.headline, pkg.scenes[0].copy.headline);
  assert.deepEqual(edited.scenes[0].transitionOut, pkg.scenes[0].transitionOut);
  assert.equal(edited.assets.a_vid_1.gen.inputs.seed, 4101);
  assert.equal(edited.revision, 7);
  assert.deepEqual(edited.compliance, pkg.compliance);
});

test('blank untouched core controls do not manufacture package structure or a save diff', () => {
  const pkg = { id: 'pkg_blank', revision: 2, title: 'Existing', scenes: [{ id: 's1' }], assets: {} };
  const edited = applyFullPlanFields(pkg, {
    '/title': 'Existing',
    '/proposal/logline': '',
    '/proposal/look': '',
    '/proposal/soundtrack': '',
    '/scenes/0/copy/headline': '',
    '/scenes/0/copy/items': '',
    '/scenes/0/narration': '',
  });
  assert.deepEqual(edited, pkg);
  assert.notEqual(edited, pkg);

  const withProposal = applyFullPlanFields(pkg, { '/proposal/logline': 'A new logline' });
  assert.deepEqual(withProposal.proposal, { logline: 'A new logline' });
  assert.equal(pkg.proposal, undefined);
});

test('fullPlanProposalScope preserves unique shot.generate targets and leaves final plans whole-film', () => {
  assert.deepEqual(fullPlanProposalScope({
    actions: [
      { kind: 'shot.generate', targetId: 'shot-2' },
      { kind: 'shot.generate', targetIds: ['shot-1', 'shot-2', ' shot-3 ', ''] },
      { kind: 'audition', targetId: 'shot-9:line-1' },
    ],
  }), { onlyShotIds: ['shot-2', 'shot-1', 'shot-3'] });

  assert.deepEqual(fullPlanProposalScope({
    actions: [
      { kind: 'shot.generate', targetId: 'shot-1' },
      { kind: 'final', targetId: 'film' },
    ],
  }), {});
  assert.deepEqual(fullPlanProposalScope({ actions: [{ kind: 'final' }] }), {});
  assert.deepEqual(fullPlanProposalScope({ actions: [{ kind: 'audition', targetId: 'line-1' }] }), {});
  assert.deepEqual(fullPlanProposalScope(null), {});
});

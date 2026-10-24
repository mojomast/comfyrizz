// SE05: the presentational Super Easy progress view.
//
// Everything here is static markup built from the stage and gallery models.
// There is no DOM and no network; the same snapshot always produces the same
// string. node:test imports are runtime-only, like the other Easy render tests.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { COPY, fill } from './copy.ts';
import { escapeHtml } from '../components.ts';
import { readStages, STAGE_IDS } from './stages.ts';
import { buildGalleryModel } from './gallery-model.ts';
import {
  progressLiveKey,
  progressLiveText,
  renderSuperEasyProgress,
} from './progress-view.ts';

function count(html, pattern) {
  return (html.match(pattern) || []).length;
}

function stageBlock(html, id) {
  const start = html.indexOf(`data-super-easy-stage="${id}"`);
  assert.ok(start >= 0, `missing stage ${id}`);
  const end = html.indexOf('</li>', start);
  assert.ok(end > start, `stage ${id} is not a list item`);
  return html.slice(start, end);
}

function gallerySlots(html) {
  return [...html.matchAll(/<li\b[^>]*data-super-easy-gallery-item="([^"]*)"[^>]*>/gu)]
    .map((match) => ({ tag: match[0], id: match[1] }));
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`, 'u'));
  assert.ok(match, `missing ${name} in ${tag}`);
  return match[1];
}

function partialSnapshot() {
  return {
    plan: { status: 'done' },
    characters: { done: 1, total: 2 },
    shots: [{ status: 'approved' }, { status: 'review' }],
    voice: { status: 'starting' },
    render: { status: 'running', fraction: 0.4 },
  };
}

function completeSnapshot() {
  return {
    plan: { status: 'done' },
    characters: { status: 'done' },
    shots: [{ status: 'approved' }],
    voice: { status: 'done' },
    render: { status: 'running', fraction: 0.7 },
    finalVideo: { ready: true, url: '/media/final.mp4' },
  };
}

function gallerySnapshot() {
  return {
    production: {
      id: 'prod_1',
      revision: 4,
      shotIds: ['shot_1', 'shot_2', 'shot_3'],
      characterBindings: [
        { characterId: 'char_mira', name: 'Mira', artifactId: 'art_mira' },
        { characterId: 'char_bo' },
      ],
      latestDeliveryId: 'del_1',
    },
    characters: [{ id: 'char_mira', name: 'Mira', status: 'ready' }],
    artifacts: [
      { id: 'art_mira', kind: 'identity', metadata: { imageUrl: '/media/mira.png' } },
      { id: 'art_s1', kind: 'conditioning', shotId: 'shot_1', url: '/media/shot-1.png' },
      { id: 'art_s2', kind: 'native_take', metadata: { shotId: 'shot_2', videoUrl: 'https://cdn.example/shot-2.mp4' } },
      { id: 'art_v1', kind: 'audition', metadata: { shotId: 'shot_1', audioUrl: '/media/voice-1.mp3' } },
    ],
    actions: [
      { id: 'act_1', shotId: 'shot_1', state: 'completed' },
      { id: 'act_2', shotId: 'shot_2', state: 'running' },
      { id: 'act_3', shotId: 'shot_3', state: 'planned' },
    ],
    deliveries: [{ id: 'del_1', status: 'ready', url: '/media/final.mp4' }],
  };
}

test('the overall gauge and one gauge per stage render from the stage model', () => {
  const html = renderSuperEasyProgress(partialSnapshot());

  assert.match(html, /<section[^>]*class="super-easy-progress[^"]*"[^>]*data-super-easy-progress/u);
  assert.match(html, /data-super-easy-overall-gauge/u);
  assert.equal(count(html, /role="progressbar"/g), STAGE_IDS.length + 1, 'one overall plus five stage gauges');
  assert.equal(count(html, /data-super-easy-stage-gauge/g), STAGE_IDS.length);

  const overall = html.match(/data-super-easy-overall-gauge[\s\S]*?role="progressbar"[^>]*aria-valuenow="48"/u);
  assert.ok(overall, 'overall gauge is 48 percent for the partial snapshot');

  for (const id of STAGE_IDS) {
    const block = stageBlock(html, id);
    assert.match(block, /role="progressbar"/u, `${id} gauge exists`);
    assert.match(block, new RegExp(`data-stage-status="`, 'u'), `${id} exposes its status`);
    assert.match(block, new RegExp(`aria-label="${COPY.stages[id === 'render' ? 'video' : id]}"`, 'u'));
  }

  const plan = stageBlock(html, 'plan');
  assert.match(plan, /aria-valuenow="100"/u);
  assert.match(plan, /data-stage-status="done"/u);
  assert.match(plan, />Done</u);

  const characters = stageBlock(html, 'characters');
  assert.match(characters, /aria-valuenow="50"/u);
  assert.match(characters, /data-stage-status="running"/u);

  const voice = stageBlock(html, 'voice');
  assert.match(voice, /aria-valuenow="0"/u);
  assert.match(voice, /data-stage-status="starting"/u);
  assert.match(voice, />Starting</u);
});

test('a ready final video brings the overall gauge to 100 percent and the done copy', () => {
  const html = renderSuperEasyProgress(completeSnapshot());

  assert.match(html, /data-super-easy-overall-gauge[\s\S]*?aria-valuenow="100"/u);
  assert.match(html, /data-super-easy-overall-value[^>]*>All done</u);
  assert.match(html, new RegExp(`>${COPY.making.overall}<`, 'u'));
  assert.equal(COPY.making.overall, 'All done');
});

test('stage errors are visible text and never hidden behind a done gauge', () => {
  const html = renderSuperEasyProgress({
    plan: { status: 'done' },
    shots: { status: 'error', fraction: 0.4, error: 'Shot 2 failed <again>' },
    finalVideo: { status: 'rendering' },
  });

  const shots = stageBlock(html, 'shots');
  assert.match(shots, /data-stage-status="error"/u);
  assert.match(shots, />Error</u);
  assert.match(shots, /Shot 2 failed &lt;again&gt;/u);
  assert.match(shots, /aria-valuenow="40"/u);
  assert.doesNotMatch(shots, /Shot 2 failed <again>/u);
});

test('gallery slots render characters, shots, voices and the final video', () => {
  const snapshot = gallerySnapshot();
  const model = buildGalleryModel(snapshot);
  const html = renderSuperEasyProgress(snapshot);

  assert.match(html, /data-super-easy-gallery/u);
  assert.equal(count(html, /data-super-easy-gallery-item=/g), model.items.length);
  assert.equal(model.items.length, 7);

  const slots = gallerySlots(html);
  assert.deepEqual(slots.map((slot) => slot.id), model.items.map((item) => item.id));
  assert.deepEqual(slots.map((slot) => attr(slot.tag, 'data-gallery-kind')), [
    'character',
    'character',
    'shot',
    'shot',
    'shot',
    'voice',
    'final',
  ]);
  assert.deepEqual(slots.map((slot) => attr(slot.tag, 'data-gallery-state')), [
    'ready',
    'empty',
    'ready',
    'ready',
    'empty',
    'ready',
    'ready',
  ]);

  const finalSlot = slots.at(-1);
  assert.equal(finalSlot.id, 'final');
  assert.match(finalSlot.tag, /data-gallery-highlighted="true"/u);
  assert.match(html, new RegExp(`>${COPY.stages.video}</p>`, 'u'));

  assert.match(html, /src="\/media\/mira\.png"/u);
  assert.match(html, /src="\/media\/shot-1\.png"/u);
  assert.match(html, /src="https:\/\/cdn\.example\/shot-2\.mp4"/u);
  assert.match(html, /src="\/media\/voice-1\.mp3"/u);
  assert.match(html, /src="\/media\/final\.mp4"/u);
});

test('failed gallery slots show the shared gallery error copy', () => {
  const html = renderSuperEasyProgress({
    production: {
      id: 'prod_fail',
      shotIds: ['shot_fail'],
      characterBindings: [{ characterId: 'char_fail', status: 'failed' }],
      latestDeliveryId: 'del_fail',
    },
    actions: [{ id: 'act_fail', shotId: 'shot_fail', state: 'failed' }],
    deliveries: [{ id: 'del_fail', status: 'failed' }],
  });

  assert.ok(html.includes(escapeHtml(fill(COPY.gallery.error, { stage: 'the characters' }))));
  assert.ok(html.includes(escapeHtml(fill(COPY.gallery.error, { stage: 'this shot' }))));
  assert.ok(html.includes(escapeHtml(fill(COPY.gallery.error, { stage: 'the video' }))));
});

test('the live region is polite, atomic and present even when it is empty', () => {
  const html = renderSuperEasyProgress({});
  const live = html.match(/<p\b[^>]*data-super-easy-live[^>]*>([\s\S]*?)<\/p>/u);
  assert.ok(live, 'live region is present');
  assert.match(live[0], /role="status"/u);
  assert.match(live[0], /aria-live="polite"/u);
  assert.match(live[0], /aria-atomic="true"/u);
  assert.equal(live[1], '');

  const announced = renderSuperEasyProgress({}, { liveText: 'Ready to make <your> video.' });
  const custom = announced.match(/<p\b[^>]*data-super-easy-live[^>]*>([\s\S]*?)<\/p>/u);
  assert.equal(custom[1], 'Ready to make &lt;your&gt; video.');
});

test('the live key changes for big stage moves but not for gauge fractions', () => {
  const slow = readStages({ render: { status: 'running', fraction: 0.2 } });
  const faster = readStages({ render: { status: 'running', fraction: 0.8 } });
  assert.equal(progressLiveKey(slow), progressLiveKey(faster));

  const stageMoved = readStages({
    plan: { status: 'running', fraction: 0.5 },
    render: { status: 'running', fraction: 0.2 },
  });
  assert.notEqual(progressLiveKey(faster), progressLiveKey(stageMoved));

  const done = readStages(completeSnapshot());
  assert.equal(progressLiveText(done), COPY.done.title);
  assert.equal(COPY.done.title, 'Your video is ready!');

  const failed = readStages({
    shots: { status: 'error', error: 'Shot 2 failed' },
    finalVideo: { status: 'rendering' },
  });
  assert.match(progressLiveText(failed), /Shots: Shot 2 failed/u);

  assert.match(progressLiveText(readStages(partialSnapshot())), /Working: Plan|Working: Characters|Working: Voice/u);
});

test('reduced motion adds the class hook and the stylesheet honours the OS preference', () => {
  const normal = renderSuperEasyProgress({});
  assert.doesNotMatch(normal, /super-easy-progress-reduced-motion/u);
  assert.doesNotMatch(normal, /data-reduced-motion=/u);

  const reduced = renderSuperEasyProgress({}, { reducedMotion: true });
  assert.match(reduced, /class="super-easy-progress super-easy-progress-reduced-motion"/u);
  assert.match(reduced, /data-reduced-motion="true"/u);

  const css = readFileSync(fileURLToPath(new URL('./progress-view.css', import.meta.url)), 'utf8');
  for (const selector of [
    '.super-easy-progress',
    '.super-easy-progress-overall',
    '.super-easy-progress-stages',
    '.super-easy-progress-stage',
    '.super-easy-progress-gallery',
    '.super-easy-progress-slot',
    '.super-easy-progress-live',
    '.super-easy-progress-reduced-motion',
  ]) {
    assert.ok(css.includes(selector), `missing ${selector}`);
  }
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(css, /\.super-easy-progress-reduced-motion[^{]*\{[^}]*transition:\s*none/u);
  assert.doesNotMatch(css, /@import/u);
  assert.doesNotMatch(css, /url\(\s*['"]?https?:/iu);
});

test('labels come from the shared copy and the model, not from the view', () => {
  const html = renderSuperEasyProgress(partialSnapshot());

  assert.match(html, new RegExp(`>${COPY.making.title}</h1>`, 'u'));
  assert.match(html, new RegExp(`>${COPY.making.subtitle}</p>`, 'u'));
  for (const label of [COPY.stages.plan, COPY.stages.characters, COPY.stages.shots, COPY.stages.voice, COPY.stages.video]) {
    assert.ok(html.includes(`>${label}</span>`), `missing stage label ${label}`);
  }
  assert.match(html, new RegExp(`aria-label="${COPY.gallery.empty}"`, 'u'));
});

test('snapshot labels and ids are escaped before they reach the page', () => {
  const html = renderSuperEasyProgress({
    production: {
      shotIds: ['shot_1', 'shot"<script>'],
      characterBindings: [{ characterId: 'char_1' }],
    },
    characters: [{ id: 'char_1', name: '<b>Mira</b>' }],
    shots: [{ id: 'shot"<script>', label: '<img src=x onerror="alert(1)">' }],
    artifacts: [
      { id: 'art_bad', kind: 'conditioning', shotId: 'shot_1', url: 'javascript:alert(1)' },
    ],
    actions: [
      { id: 'act_1', shotId: 'shot_1', state: 'completed' },
      { id: 'act_2', shotId: 'shot"<script>', state: 'completed' },
    ],
  });

  assert.doesNotMatch(html, /<script>/u);
  assert.doesNotMatch(html, /<img src=x/u);
  assert.doesNotMatch(html, /<b>Mira<\/b>/u);
  assert.match(html, /&lt;b&gt;Mira&lt;\/b&gt;/u);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/u);
  assert.doesNotMatch(html, /src="javascript:/u);
});

test('the view is offline: no fetch, sockets or remote assets', () => {
  const source = readFileSync(fileURLToPath(new URL('./progress-view.ts', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b/u);
  assert.doesNotMatch(source, /https?:\/\//u);
  assert.doesNotMatch(source, /['"]colab['"]/iu);
});

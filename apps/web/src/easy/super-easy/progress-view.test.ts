// SE05: the presentational Super Easy progress view.
//
// The full markup is deterministic and comes from the stage and gallery
// models. The DOM updater is exercised against a tiny fake so fraction-only
// events never replace media, escapes or the live region. node:test imports
// are runtime-only, like the other Easy render tests.
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
  superEasyProgressParts,
  updateSuperEasyProgress,
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

test('the progress screen keeps the Comfyrizz brand visible', () => {
  const html = renderSuperEasyProgress(partialSnapshot());
  assert.match(html, /class="super-easy-brand" aria-label="Comfyrizz"/u);
  assert.match(html, /class="super-easy-brand-name">Comfyrizz<\/span>/u);
});

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

test('a ready final video offers Download, Open in Studio, Make another and a secondary editor escape', () => {
  const html = renderSuperEasyProgress(completeSnapshot(), {
    packageId: 'pkg_123',
    search: '?package=pkg_123&from=shared',
  });

  const download = html.match(/<a\b[^>]*data-super-easy-download[^>]*>([\s\S]*?)<\/a>/u);
  assert.ok(download, 'Download is an anchor so the existing final URL is used');
  assert.match(download[0], /href="\/media\/final\.mp4"/u);
  assert.match(download[0], /class="[^"]*\bbtn-primary\b[^"]*"/u);
  assert.match(download[0], /\bdownload\b/u);
  assert.equal(download[1], COPY.done.download);
  assert.equal(COPY.done.download, 'Download');

  const studio = html.match(/<a\b[^>]*data-super-easy-open-studio[^>]*>([\s\S]*?)<\/a>/u);
  assert.ok(studio, 'Open in Studio keeps the package');
  assert.match(studio[0], /href="\?package=pkg_123&amp;from=shared&amp;step=idea"/u);
  assert.equal(studio[1], COPY.done.openStudio);
  assert.equal(COPY.done.openStudio, 'Open in Studio');

  assert.match(html, /<button[^>]*data-super-easy-make-another[^>]*>Make another<\/button>/u);
  assert.match(html, /<button[^>]*class="[^"]*\bbtn-secondary\b[^"]*"[^>]*data-super-easy-open-editor[^>]*>Open in editor<\/button>/u);
  assert.equal((html.match(/data-super-easy-download/g) ?? []).length, 1);
  assert.equal((html.match(/data-super-easy-open-studio/g) ?? []).length, 1);
  assert.equal((html.match(/data-super-easy-make-another/g) ?? []).length, 1);
  assert.equal((html.match(/data-super-easy-open-editor/g) ?? []).length, 1);

  const order = ['data-super-easy-download', 'data-super-easy-open-studio', 'data-super-easy-make-another', 'data-super-easy-open-editor']
    .map((hook) => html.indexOf(hook));
  assert.deepEqual(order, order.slice().sort((left, right) => left - right), 'Download comes first and the editor escape last');
});

test('done actions stay away until the final video is ready', () => {
  const html = renderSuperEasyProgress(partialSnapshot());
  assert.doesNotMatch(html, /data-super-easy-done-actions/u);
  assert.doesNotMatch(html, /data-super-easy-download/u);
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

// UX06: preview-ready, errors and stable progress updates.

function mediaTags(html) {
  return [...html.matchAll(/<(?:audio|video|img)\b[^>]*>/gu)].map((match) => match[0]);
}

function fakeProgressRoot() {
  const writes = { chrome: 0, gallery: 0, actions: 0, live: 0, gauges: 0 };
  const region = (kind) => {
    let html = '';
    return {
      get innerHTML() {
        return html;
      },
      set innerHTML(value) {
        html = value;
        writes[kind] += 1;
      },
    };
  };
  let liveText = '';
  const live = {
    attributes: {},
    get textContent() {
      return liveText;
    },
    set textContent(value) {
      liveText = value;
      writes.live += 1;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  };
  const gauges = STAGE_IDS.map((id) => ({
    id,
    innerHTML: '',
    getAttribute(name) {
      return name === 'data-stage-id' ? this.id : null;
    },
    set innerHTML(value) {
      this.innerHTMLValue = value;
      writes.gauges += 1;
    },
    get innerHTML() {
      return this.innerHTMLValue ?? '';
    },
  }));
  const overallGauge = region('gauges');
  const overallValue = { textContent: '' };
  const nodes = new Map([
    ['[data-super-easy-live]', live],
    ['[data-super-easy-chrome]', region('chrome')],
    ['[data-super-easy-gallery]', region('gallery')],
    ['[data-super-easy-actions]', region('actions')],
    ['[data-super-easy-overall-gauge]', overallGauge],
    ['[data-super-easy-overall-value]', overallValue],
  ]);
  return {
    writes,
    live,
    overallValue,
    gauges,
    overallGauge,
    root: {
      querySelector(selector) {
        return nodes.get(selector) ?? null;
      },
      querySelectorAll(selector) {
        return selector === '[data-super-easy-stage-gauge]' ? gauges : [];
      },
    },
  };
}

function audioSnapshot(fraction) {
  return {
    plan: { status: 'done' },
    characters: { status: 'done' },
    shots: [{ status: 'approved' }],
    voice: { status: 'done', url: '/media/voice.mp3' },
    render: { status: 'running', fraction },
  };
}

test('preview-ready has its own Review handoff and never claims the finished video', () => {
  const html = renderSuperEasyProgress(partialSnapshot(), { previewReady: true });

  assert.match(html, /data-super-easy-preview-ready/u);
  assert.match(html, /<button[^>]*class="btn btn-primary"[^>]*data-super-easy-export[^>]*>Download preview MP4<\/button>/u);
  assert.match(html, /<button[^>]*class="btn btn-secondary"[^>]*data-super-easy-review[^>]*>Watch and review<\/button>/u);
  assert.doesNotMatch(html, /data-super-easy-done-actions/u);
  assert.doesNotMatch(html, /data-super-easy-download/u);
  assert.doesNotMatch(html, new RegExp(COPY.done.title, 'u'));
});

test('the next action sits above the gauges, inside the one centred column', () => {
  const html = renderSuperEasyProgress(partialSnapshot(), { previewReady: true });
  const section = html.indexOf('<section class="super-easy-progress"');
  const actions = html.indexOf('data-super-easy-actions');
  const gallery = html.indexOf('data-super-easy-gallery>');
  const chrome = html.indexOf('data-super-easy-chrome>');
  const close = html.lastIndexOf('</section>');
  assert.ok(section >= 0 && section < actions, 'actions live inside the progress section');
  assert.ok(actions < chrome, 'the call to action comes before the gauges');
  assert.ok(gallery < chrome, 'emerging assets are the visual focus above the gauges');
  assert.ok(close > chrome, 'the progress section closes after the gallery');
  assert.ok(html.trimEnd().endsWith('</section>'), 'nothing trails outside the column');
});

test('progress-view.css styles the preview card and moves running gauges', () => {
  const css = readFileSync(fileURLToPath(new URL('./progress-view.css', import.meta.url)), 'utf8');
  for (const selector of [
    '.super-easy-progress-actions:empty',
    '.super-easy-progress-preview',
    '.super-easy-progress-error',
    '.super-easy-progress-stage-running .easy-progress::after',
    '@keyframes super-easy-progress-sweep',
    '.super-easy-progress-reduced-motion .easy-progress::after',
    '#easy-root[data-super-easy-view]',
    '@keyframes super-easy-asset-pop',
    'minmax(140px, 1fr)',
  ]) {
    assert.ok(css.includes(selector), `missing ${selector}`);
  }
});

test('a running stage with a custom status text repaints its chrome', () => {
  const base = readStages(partialSnapshot());
  const relabel = (statusText: string) => ({
    ...base,
    stages: base.stages.map((stage) => (stage.id === 'render' ? { ...stage, statusText } : stage)),
  });
  const running = superEasyProgressParts(partialSnapshot(), { stages: relabel('Running') });
  const preview = superEasyProgressParts(partialSnapshot(), { stages: relabel('Preview ready') });
  assert.notEqual(running.keys.chrome, preview.keys.chrome);
  assert.match(preview.chromeHtml, />Preview ready</u);
});

test('a delivery id or ready flag without a playable URL is not a final-ready claim', () => {
  const idOnly = {
    production: { id: 'prod_1', latestDeliveryId: 'del_1' },
    plan: { status: 'done' },
    characters: { status: 'done' },
    shots: [{ status: 'approved' }],
    voice: { status: 'done' },
    render: { status: 'done' },
    finalVideo: { ready: true, status: 'ready' },
    deliveries: [{ id: 'del_1', status: 'ready' }],
  };
  const html = renderSuperEasyProgress(idOnly);
  assert.doesNotMatch(html, /data-super-easy-done-actions/u);
  assert.doesNotMatch(html, /data-super-easy-download/u);
  assert.doesNotMatch(html, new RegExp(COPY.done.title, 'u'));
  assert.doesNotMatch(html, /data-super-easy-overall-gauge><div class="easy-progress"[^>]*aria-valuenow="100"/u);
  assert.match(html, /data-super-easy-stage="render" data-stage-status="running"/u);
  assert.doesNotMatch(html, /data-super-easy-stage="render" data-stage-status="done"/u);
  assert.notEqual(
    progressLiveText(readStages(idOnly), buildGalleryModel(idOnly)),
    COPY.done.title,
  );

  const playable = {
    ...idOnly,
    finalVideo: { ready: true, url: '/media/final.mp4' },
    deliveries: [{ id: 'del_1', status: 'ready', url: '/media/final.mp4' }],
  };
  assert.match(renderSuperEasyProgress(playable), /data-super-easy-done-actions/u);
  assert.match(renderSuperEasyProgress(playable), /data-super-easy-download/u);

  const deliveryOnly = {
    ...idOnly,
    finalVideo: undefined,
    production: { id: 'prod_1' },
    deliveries: [{ id: 'del_1', status: 'ready', url: '/media/final.mp4' }],
  };
  const deliveryHtml = renderSuperEasyProgress(deliveryOnly);
  assert.match(deliveryHtml, /data-super-easy-done-actions/u);
  assert.match(deliveryHtml, /data-super-easy-stage="render" data-stage-status="done"/u);
  assert.match(deliveryHtml, /data-super-easy-overall-gauge><div class="easy-progress"[^>]*aria-valuenow="100"/u);
});

test('a planning failure is visible with retry and an escape', () => {
  const html = renderSuperEasyProgress({}, {
    failure: { message: 'The plan could not be written <again>.', retryable: true },
  });

  assert.match(html, /data-super-easy-error/u);
  assert.match(html, /The plan could not be written &lt;again&gt;\./u);
  assert.match(html, /data-super-easy-retry/u);
  assert.match(html, /data-super-easy-more-control/u);
  assert.match(html, /data-super-easy-open-editor/u);
  assert.doesNotMatch(html, /data-super-easy-done-actions/u);
  assert.match(html, /The plan could not be written &lt;again&gt;\./u);
});

test('fraction-only progress updates keep the media, live region and escapes untouched', () => {
  const first = superEasyProgressParts(audioSnapshot(0.2));
  const next = superEasyProgressParts(audioSnapshot(0.8));
  const fake = fakeProgressRoot();

  const keys = updateSuperEasyProgress(fake.root, first.keys, audioSnapshot(0.8));

  assert.deepEqual(keys, first.keys, 'only gauges changed');
  assert.equal(fake.writes.chrome, 0, 'stage markup is not replaced');
  assert.equal(fake.writes.gallery, 0, 'the playing sample is not replaced');
  assert.equal(fake.writes.actions, 0, 'the focused escape is not replaced');
  assert.equal(fake.writes.live, 0, 'the live region is not replaced');
  assert.ok(fake.writes.gauges > 0, 'the measured gauges still move');
  assert.deepEqual(mediaTags(first.html), mediaTags(next.html));
  assert.ok(mediaTags(first.html).some((tag) => tag.startsWith('<audio')), 'a sample is present');
});

test('a meaningful stage change updates the persistent live region and chrome only', () => {
  const before = {
    plan: { status: 'running', fraction: 0.5 },
    characters: { status: 'waiting' },
    voice: { status: 'done', url: '/media/voice.mp3' },
    render: { status: 'running', fraction: 0.2 },
  };
  const after = { ...before, plan: { status: 'done' } };
  const first = superEasyProgressParts(before);
  const fake = fakeProgressRoot();

  const keys = updateSuperEasyProgress(fake.root, first.keys, after);

  assert.notDeepEqual(keys, first.keys);
  assert.equal(fake.writes.chrome, 1);
  assert.equal(fake.writes.gallery, 0);
  assert.equal(fake.writes.actions, 0);
  assert.equal(fake.writes.live, 1);
  assert.match(fake.live.textContent, /Working:/u);
});

function keyedGalleryRoot(parts) {
  let fullWrites = 0;
  let replaced = 0;
  const nodes = [];

  function makeNode(html) {
    const id = /data-super-easy-gallery-item="([^"]*)"/u.exec(html)?.[1] ?? '';
    const key = /data-gallery-item-key="([^"]*)"/u.exec(html)?.[1] ?? '';
    let outer = html;
    const node = {
      id,
      key,
      parent: nodes,
      get outerHTML() {
        return outer;
      },
      set outerHTML(value) {
        outer = value;
        replaced += 1;
      },
      getAttribute(name) {
        if (name === 'data-super-easy-gallery-item') return this.id;
        if (name === 'data-gallery-item-key') return this.key;
        return null;
      },
      insertAdjacentHTML(position, value) {
        if (position !== 'beforebegin') throw new Error(`unexpected position ${position}`);
        const index = this.parent.indexOf(this);
        if (index < 0) throw new Error('detached anchor');
        this.parent.splice(index, 0, makeNode(value));
      },
      remove() {
        const index = this.parent.indexOf(this);
        if (index >= 0) this.parent.splice(index, 1);
      },
    };
    return node;
  }

  for (const slot of parts.gallerySlots) nodes.push(makeNode(slot.html));

  const list = {
    insertAdjacentHTML(position, value) {
      if (position !== 'beforeend') throw new Error(`unexpected position ${position}`);
      nodes.push(makeNode(value));
    },
  };
  const gallery = {
    get innerHTML() {
      return '';
    },
    set innerHTML(_value) {
      fullWrites += 1;
    },
    querySelectorAll(selector) {
      if (selector === '[data-super-easy-gallery-item]') return nodes.slice();
      if (selector === 'ul,ol') return [list];
      return [];
    },
    insertAdjacentHTML() {
      throw new Error('new gallery tiles must be inserted into the list, not the section');
    },
  };
  const live = { textContent: '', setAttribute() {} };
  const root = {
    querySelector(selector) {
      if (selector === '[data-super-easy-gallery]') return gallery;
      if (selector === '[data-super-easy-live]') return live;
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
  return {
    root,
    nodes,
    live,
    writes: () => ({ fullWrites, replaced }),
  };
}

test('a new gallery tile is keyed in place and does not replace a playing sample', () => {
  const before = {
    plan: { status: 'done' },
    characters: { status: 'done' },
    voice: { status: 'done', url: '/media/voice.mp3' },
    render: { status: 'running', fraction: 0.2 },
  };
  const first = superEasyProgressParts(before);
  const fake = keyedGalleryRoot(first);
  const voice = fake.nodes.find((node) => node.id === 'voice:voice-1');
  const final = fake.nodes.find((node) => node.id === 'final');
  assert.ok(voice, 'the voice sample exists before the update');
  assert.match(voice.outerHTML, /<audio\b/u);

  const after = {
    ...before,
    shots: [{ id: 'shot_1', status: 'approved', url: '/media/shot-1.png' }],
  };
  const keys = updateSuperEasyProgress(fake.root, first.keys, after);

  assert.notEqual(keys.gallery, first.keys.gallery);
  assert.deepEqual(fake.writes(), { fullWrites: 0, replaced: 0 });
  assert.equal(fake.nodes.find((node) => node.id === 'voice:voice-1'), voice, 'the playing sample node is kept');
  assert.equal(fake.nodes.find((node) => node.id === 'final'), final, 'the final tile node is kept');
  assert.deepEqual(fake.nodes.map((node) => node.id), ['character:character-1', 'shot:shot_1', 'voice:voice-1', 'final']);
  assert.match(voice.outerHTML, /<audio\b/u);
});

test('an active run offers both a Studio escape and a way back to a new prompt', () => {
  const html = superEasyProgressParts(partialSnapshot()).html;
  assert.match(html, /data-super-easy-more-control/);
  assert.match(html, /Open in Studio/);
  assert.match(html, /Switch views without stopping your work/);
  assert.match(html, /data-super-easy-make-another/);
  assert.match(html, /Stop and start a new prompt/);
  assert.match(html, /Any active video run is cancelled/);
});

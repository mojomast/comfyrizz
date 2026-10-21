// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SheetButtonController,
  createSheetButton,
  hasPrimaryImage,
  mountSheetButton,
  primaryImage,
  renderSheetButton,
  sheetAvailability,
} from '../src/characters/sheet-button.ts';

function image(overrides = {}) {
  return {
    imgId: 'img_aaaaaaaaaaaaaaaa',
    view: 'front',
    primary: true,
    source: 'upload',
    sha256: 'a'.repeat(64),
    width: 64,
    height: 64,
    ...overrides,
  };
}

function character(images = [image()], overrides = {}) {
  return {
    schema: 'comfyrizz.character/v1',
    id: 'chr_0123456789abcdef',
    revision: 2,
    name: 'Pip',
    handle: 'pip',
    role: 'mascot',
    kind: 'fictional',
    summary: 'Round, cheerful coffee-bean mascot',
    visual: {
      identityPrompt: 'small round coffee bean, glossy brown',
      negative: 'no human face',
      style: 'flat 3D',
      palette: ['#5b3a1e'],
      wardrobe: [],
      expressions: [],
      images,
      sheet: { status: 'none' },
      seed: null,
      identity: { method: 'klein_ref' },
    },
    voice: { engine: 'none', sampleLines: [] },
    bible: {
      personality: 'upbeat',
      mannerisms: [],
      catchphrases: [],
      speakingStyle: '',
      do: [],
      dont: [],
      notes: '',
    },
    tags: [],
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    ...overrides,
  };
}

function sheetImage(overrides = {}) {
  return image({
    imgId: 'img_cccccccccccccccc',
    view: 'other',
    primary: false,
    source: 'generated',
    sha256: 'c'.repeat(64),
    ...overrides,
  });
}

function plan(overrides = {}) {
  return {
    planHash: 'ph_sheet_1',
    backendId: 'colab',
    workflow: 'flux3_klein_ref_edit',
    estimate: { gpuMinutes: 0.4, jobs: 1 },
    budget: { message: 'One Klein run within budget.' },
    jobs: 1,
    approvalRequired: true,
    ...overrides,
  };
}

function fakeApi(config = {}) {
  const calls = { plan: [], generate: [], update: [] };
  let current = structuredClone(config.character ?? character());
  const api = {
    calls,
    async planSheet(id, options) {
      calls.plan.push({ id, options });
      if (config.planError) throw config.planError;
      return structuredClone(config.plan ?? plan());
    },
    async generateSheet(id, request) {
      calls.generate.push({ id, request: structuredClone(request) });
      if (config.generateError) throw config.generateError;
      return config.generate ?? { image: sheetImage() };
    },
  };
  if (config.update !== false) {
    api.update = async (id, patch, options) => {
      calls.update.push({ id, patch: structuredClone(patch), options });
      if (config.updateError) throw config.updateError;
      current = {
        ...current,
        revision: current.revision + 1,
        visual: { ...current.visual, ...structuredClone(patch.visual) },
      };
      return config.updateResult ? config.updateResult(structuredClone(current)) : structuredClone(current);
    };
  }
  return api;
}

test('the button is disabled until the character has a primary image', async () => {
  const noImage = fakeApi({ character: character([]) });
  const noImageButton = createSheetButton({ api: noImage, character: character([]) });
  assert.equal(hasPrimaryImage(character([])), false);
  assert.equal(primaryImage(character([])), null);
  assert.equal(noImageButton.getState().disabled, true);
  assert.match(noImageButton.getState().disabledReason, /primary image/);
  assert.match(noImageButton.render(), /data-action="sheet-generate" disabled/);
  const started = await noImageButton.start();
  assert.equal(started.phase, 'error');
  assert.match(started.message, /primary image/);
  assert.equal(noImage.calls.plan.length, 0);

  const ready = createSheetButton({ api: fakeApi(), character: character() });
  assert.equal(ready.getState().disabled, false);
  assert.doesNotMatch(ready.render(), /data-action="sheet-generate" disabled/);
});

test('a character without an image is rejected rather than calling the api', async () => {
  const api = fakeApi();
  const button = createSheetButton({ api, character: null });
  assert.equal(button.getState().disabled, true);
  assert.equal(sheetAvailability(null).disabled, true);
  await button.start();
  assert.equal(api.calls.plan.length, 0);
  assert.equal(button.getState().phase, 'error');
});

test('a character id is loaded before planning', async () => {
  const api = fakeApi();
  let loads = 0;
  api.get = async id => {
    loads += 1;
    assert.equal(id, 'chr_0123456789abcdef');
    return character();
  };
  const button = createSheetButton({ api, characterId: 'chr_0123456789abcdef' });
  assert.equal(button.getState().disabled, true);
  const state = await button.start();
  assert.equal(loads, 1);
  assert.equal(state.phase, 'approval');
  assert.equal(state.character.id, 'chr_0123456789abcdef');
  assert.equal(api.calls.plan.length, 1);
});

test('requesting a sheet shows spend approval and does not generate yet', async () => {
  const api = fakeApi();
  const button = createSheetButton({ api, character: character() });
  const state = await button.start();
  assert.equal(state.phase, 'approval');
  assert.equal(state.plan.planHash, 'ph_sheet_1');
  assert.equal(state.disabled, true);
  assert.equal(api.calls.plan.length, 1);
  assert.equal(api.calls.generate.length, 0);
  assert.equal(api.calls.update.length, 0);
  const html = button.render();
  assert.match(html, /Spend approval needed/);
  assert.match(html, /Approve spend/);
  assert.match(html, /One Klein run within budget\./);
  assert.match(html, /0\.4 GPU minutes/);
  assert.match(html, /ph_sheet_1/);
});

test('approval generates once and adds the result as a non-primary image', async () => {
  const api = fakeApi({
    generate: { image: sheetImage({ primary: true }) },
  });
  const start = character([
    image(),
    image({ imgId: 'img_bbbbbbbbbbbbbbbb', view: 'side', primary: false, sha256: 'b'.repeat(64) }),
  ]);
  const button = createSheetButton({ api, character: start });
  await button.start();
  const run = await button.approve();
  assert.equal(run.ok, true);
  assert.equal(api.calls.generate.length, 1);
  assert.deepEqual(api.calls.generate[0], {
    id: start.id,
    request: { planHash: 'ph_sheet_1', approved: true, signal: undefined },
  });
  assert.equal(api.calls.update.length, 1);
  const patch = api.calls.update[0].patch;
  assert.equal(patch.visual.images.length, 3);
  assert.equal(patch.visual.images[2].imgId, 'img_cccccccccccccccc');
  assert.equal(patch.visual.images[2].primary, false);
  assert.equal(patch.visual.images[2].view, 'other');
  assert.equal(patch.visual.images[2].source, 'generated');
  assert.equal(patch.visual.sheet.status, 'ready');
  assert.equal(patch.visual.sheet.imgId, 'img_cccccccccccccccc');

  const state = run.state;
  assert.equal(state.phase, 'done');
  assert.equal(state.character.visual.images.length, 3);
  assert.equal(state.character.visual.images.filter(item => item.primary).length, 1);
  assert.equal(state.character.visual.images[0].imgId, 'img_aaaaaaaaaaaaaaaa');
  assert.equal(state.character.visual.images[0].primary, true);
  assert.equal(state.character.visual.images[2].primary, false);
  assert.equal(state.image.primary, false);
  assert.match(state.message, /non-primary image/);
  assert.doesNotMatch(button.render(), /Spend approval needed/);
  const replanned = await button.generate();
  assert.equal(replanned.phase, 'approval');
  assert.equal(api.calls.generate.length, 1);
  assert.equal(api.calls.plan.length, 2);
});

test('a character returned by the api is kept and its sheet image corrected to non-primary', async () => {
  const generated = sheetImage({ primary: true });
  const returned = character([image(), generated], {
    revision: 3,
    visual: {
      ...character().visual,
      images: [image(), generated],
      sheet: { status: 'ready', imgId: generated.imgId, genSeed: 7 },
    },
  });
  const api = fakeApi({
    update: false,
    generate: { character: returned },
  });
  const button = createSheetButton({ api, character: character() });
  await button.start();
  const run = await button.approve();
  assert.equal(run.ok, true);
  assert.equal(run.state.phase, 'done');
  assert.equal(run.state.character.visual.images[1].imgId, generated.imgId);
  assert.equal(run.state.character.visual.images[1].primary, false);
  assert.equal(run.state.character.visual.sheet.status, 'ready');
  assert.equal(run.state.character.visual.sheet.genSeed, 7);
  assert.equal(api.calls.update.length, 0);
});

test('cancelling a plan does not call the generation api', async () => {
  const api = fakeApi();
  const button = createSheetButton({ api, character: character() });
  await button.start();
  const state = button.cancel();
  assert.equal(state.phase, 'idle');
  assert.equal(state.plan, null);
  assert.equal(api.calls.generate.length, 0);
  assert.doesNotMatch(button.render(), /Spend approval needed/);
  assert.equal(button.getState().disabled, false);
});

test('a generation without an image is an error and leaves the character unchanged', async () => {
  const api = fakeApi({ generate: { ok: true } });
  const start = character();
  const button = createSheetButton({ api, character: start });
  await button.start();
  const run = await button.approve();
  assert.equal(run.ok, false);
  assert.equal(run.state.phase, 'error');
  assert.match(run.state.message, /without a sheet image/);
  assert.equal(api.calls.update.length, 0);
  assert.equal(button.getState().character.visual.images.length, 1);
});

test('errors are surfaced and escaped in the rendered approval or status', async () => {
  const api = fakeApi({
    plan: plan({ planHash: 'ph_<1>', budget: { message: '<script>alert(1)</script>' } }),
  });
  const button = createSheetButton({ api, character: character() });
  await button.start();
  const html = button.render();
  assert.match(html, /ph_&lt;1&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /data-sheet-approval/);
});

test('a failing plan leaves the button retryable', async () => {
  const config = { planError: new Error('Spend service <offline>') };
  const api = fakeApi(config);
  const button = createSheetButton({ api, character: character() });
  const state = await button.start();
  assert.equal(state.phase, 'error');
  assert.match(state.message, /Spend service/);
  assert.match(button.render(), /Spend service &lt;offline&gt;/);
  assert.equal(button.getState().disabled, false);

  config.planError = null;
  const retried = await button.start();
  assert.equal(retried.phase, 'approval');
  assert.equal(api.calls.plan.length, 2);
});

test('a plan without an approval hash is rejected before generation', async () => {
  const api = fakeApi({ plan: { jobs: 1 } });
  const button = createSheetButton({ api, character: character() });
  const state = await button.start();
  assert.equal(state.phase, 'error');
  assert.match(state.message, /approval hash/);
  assert.equal(api.calls.generate.length, 0);
});

test('mounting wires the generate and approve buttons', async () => {
  const api = fakeApi();
  const listeners = new Map();
  const element = {
    innerHTML: '',
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const mounted = mountSheetButton(element, { api, character: character() });
  assert.match(element.innerHTML, /Generate sheet/);
  const click = action => listeners.get('click')({
    target: { closest: () => ({ dataset: { action } }) },
  });
  click('sheet-generate');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.calls.plan.length, 1);
  assert.match(element.innerHTML, /Spend approval needed/);
  click('sheet-approve');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(api.calls.generate.length, 1);
  assert.equal(api.calls.update.length, 1);
  assert.match(element.innerHTML, /Turnaround sheet ready/);
  mounted.destroy();
  assert.equal(element.innerHTML, '');
});

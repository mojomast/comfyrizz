// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CastStripController,
  castDiff,
  castRole,
  diffRevisions,
  escapeHtml,
  formatDiffValue,
  renderCastStrip,
  updateAvailable,
} from '../src/characters/cast-strip.ts';
import {
  applyMention,
  autocompleteMentions,
  completeMention,
  findActiveMention,
  mention,
  mentionCandidates,
  normalizeMentionHandle,
  parseMentions,
} from '../src/characters/mention.ts';

function character(overrides = {}) {
  const base = {
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
      wardrobe: [{ id: 'w1', label: 'barista apron', prompt: 'green apron', default: true }],
      expressions: [],
      images: [],
      sheet: { status: 'none' },
      seed: null,
      identity: { method: 'klein_ref' },
    },
    voice: { engine: 'kokoro', voice: 'am_michael', sampleLines: ['Morning!'] },
    bible: {
      personality: 'upbeat',
      mannerisms: [],
      catchphrases: [],
      speakingStyle: 'short sentences',
      do: [],
      dont: [],
      notes: '',
    },
    tags: ['coffee'],
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
  };
  return { ...base, ...overrides };
}

function castEntry(castId, snapshot, overrides = {}) {
  return {
    castId,
    characterId: snapshot.id,
    pinnedRevision: snapshot.revision,
    snapshot,
    overrides,
    detached: false,
    orphaned: false,
    ...overrides.entry,
  };
}

function clone(value) {
  return structuredClone(value);
}

function fakeCastApi(initialCast, library, options = {}) {
  let cast = clone(initialCast);
  const calls = {
    listCast: [],
    list: [],
    updateCast: [],
    detachCast: [],
    attachCast: [],
    patchCast: [],
    removeCast: [],
  };
  const latest = new Map(library.map(item => [item.id, item]));

  const api = {
    async listCast(chatId) {
      calls.listCast.push(chatId);
      if (options.listCastError) throw options.listCastError;
      return clone(cast);
    },
    async list() {
      calls.list.push(true);
      return clone(library);
    },
    async updateCast(chatId, castId) {
      calls.updateCast.push({ chatId, castId });
      const entry = cast.find(item => item.castId === castId);
      const current = latest.get(entry.characterId);
      entry.pinnedRevision = current.revision;
      entry.snapshot = clone(current);
      return { cast: clone(cast), entry: clone(entry), changed: true };
    },
    async detachCast(chatId, castId) {
      calls.detachCast.push({ chatId, castId });
      const entry = cast.find(item => item.castId === castId);
      entry.detached = true;
      return { cast: clone(cast), entry: clone(entry), changed: true };
    },
    async attachCast(chatId, castId) {
      calls.attachCast.push({ chatId, castId });
      const entry = cast.find(item => item.castId === castId);
      entry.detached = false;
      return { cast: clone(cast), entry: clone(entry), changed: true };
    },
    async patchCast(chatId, castId, patch) {
      calls.patchCast.push({ chatId, castId, patch: clone(patch) });
      const entry = cast.find(item => item.castId === castId);
      entry.overrides = { ...(entry.overrides ?? {}), ...(patch.overrides ?? {}) };
      return { cast: clone(cast), entry: clone(entry), changed: true };
    },
    async removeCast(chatId, castId) {
      calls.removeCast.push({ chatId, castId });
      cast = cast.filter(item => item.castId !== castId);
      return { cast: clone(cast), removed: castId };
    },
  };
  return { api, calls, current: () => clone(cast) };
}

function pipProject() {
  const pip = character();
  const bean = character({
    id: 'chr_fedcba9876543210',
    revision: 1,
    name: 'Bean',
    handle: 'bean',
    role: 'narrator',
    summary: 'A tiny sidekick',
  });
  return {
    pip,
    bean,
    cast: [castEntry('c_pip', pip), castEntry('c_bean', bean)],
    library: [{ ...pip, revision: 3 }, bean],
  };
}

test('loading renders chips with handle, role and a pinned version badge', async () => {
  const project = pipProject();
  const fake = fakeCastApi(project.cast, project.library);
  const controller = new CastStripController({ api: fake.api, chatId: 'chat_abcdefgh' });

  const state = await controller.load();
  assert.equal(state.cast.length, 2);
  assert.deepEqual(fake.calls.listCast, ['chat_abcdefgh']);
  assert.deepEqual(fake.calls.list, [true]);

  const html = renderCastStrip(state);
  assert.match(html, /data-cast-chip="c_pip"/);
  assert.match(html, /@pip/);
  assert.match(html, /@bean/);
  assert.match(html, /data-cast-version[^>]*>v2</);
  assert.match(html, /data-cast-version[^>]*>v1</);
  assert.match(html, /Presenter/);
  assert.match(html, /Narrator/);
  assert.match(html, /Detach/);
  assert.match(html, /data-cast-diff="c_pip"/);
  assert.match(html, /v3 available/);
});

test('an empty project renders the add-from-library hint', () => {
  const html = renderCastStrip({
    chatId: 'chat_abcdefgh',
    cast: [],
    library: [],
    loading: false,
    busy: false,
    message: '',
    messageError: false,
    diffCastId: null,
  });
  assert.match(html, /No characters in this project yet/);
  assert.match(html, /@handle/);
});

test('update available compares the pinned revision with the library revision', () => {
  const pip = character();
  const latest = character({ revision: 3, name: 'Pip v3' });
  const entry = castEntry('c_pip', pip);

  assert.equal(updateAvailable(entry, [latest]), true);
  assert.equal(updateAvailable({ ...entry, detached: true }, [latest]), false);
  assert.equal(updateAvailable({ ...entry, pinnedRevision: 3 }, [latest]), false);
  assert.equal(updateAvailable(entry, []), false);
});

test('diffRevisions lists changed scalar and grouped fields', () => {
  const before = character();
  const after = character({
    revision: 3,
    name: 'Pip Prime',
    summary: 'Now with a hat',
    visual: {
      ...before.visual,
      identityPrompt: 'small round coffee bean with a green hat',
      wardrobe: [{ id: 'w2', label: 'green hat', prompt: 'knitted green hat', default: true }],
    },
    voice: { ...before.voice, voice: 'af_heart' },
    tags: ['coffee', 'hat'],
  });

  const rows = diffRevisions(before, after);
  const paths = rows.map(row => row.path);
  assert.ok(paths.includes('name'));
  assert.ok(paths.includes('summary'));
  assert.ok(paths.includes('visual.identityPrompt'));
  assert.ok(paths.includes('visual.wardrobe'));
  assert.ok(paths.includes('voice.voice'));
  assert.ok(paths.includes('tags'));
  assert.equal(paths.includes('visual.negative'), false);

  const diff = castDiff(castEntry('c_pip', before), [after]);
  assert.equal(diff.fromRevision, 2);
  assert.equal(diff.toRevision, 3);
  assert.equal(diff.name, 'Pip');
  assert.ok(diff.rows.length >= 6);
});

test('the update diff modal shows before and after, then Update replaces the snapshot', async () => {
  const project = pipProject();
  const latest = character({
    revision: 3,
    name: 'Pip Prime',
    visual: { ...project.pip.visual, identityPrompt: 'small round coffee bean with a hat' },
  });
  const fake = fakeCastApi(project.cast, [latest, project.bean]);
  const controller = new CastStripController({ api: fake.api, chatId: 'chat_abcdefgh' });
  await controller.load();

  assert.equal(controller.openDiff('c_pip'), true);
  const modal = renderCastStrip(controller.getState());
  assert.match(modal, /role="dialog"/);
  assert.match(modal, /Pip: v2 → v3/);
  assert.match(modal, /data-cast-diff-path="name"/);
  assert.match(modal, /Pip Prime/);
  assert.match(modal, /data-cast-diff-path="visual.identityPrompt"/);
  assert.match(modal, /small round coffee bean with a hat/);
  assert.match(modal, /data-cast-diff-update="c_pip"/);

  const updated = await controller.update('c_pip');
  assert.equal(updated, true);
  assert.deepEqual(fake.calls.updateCast, [{ chatId: 'chat_abcdefgh', castId: 'c_pip' }]);
  const entry = controller.entry('c_pip');
  assert.equal(entry.pinnedRevision, 3);
  assert.equal(entry.snapshot.name, 'Pip Prime');
  assert.equal(controller.state.diffCastId, null);
  assert.match(controller.state.message, /Pip updated to v3/);
  assert.doesNotMatch(renderCastStrip(controller.getState()), /data-cast-diff="c_pip"/);
});

test('detach stops update offers and reattach restores them', async () => {
  const project = pipProject();
  const latest = character({ revision: 3 });
  const fake = fakeCastApi(project.cast, [latest, project.bean]);
  const controller = new CastStripController({ api: fake.api, chatId: 'chat_abcdefgh' });
  await controller.load();

  assert.equal(await controller.detach('c_pip'), true);
  assert.deepEqual(fake.calls.detachCast, [{ chatId: 'chat_abcdefgh', castId: 'c_pip' }]);
  assert.equal(controller.entry('c_pip').detached, true);
  assert.equal(controller.updateAvailable('c_pip'), false);
  let html = renderCastStrip(controller.getState());
  assert.match(html, /data-cast-detached/);
  assert.match(html, /data-cast-attach="c_pip"/);
  assert.doesNotMatch(html, /data-cast-diff="c_pip"/);

  assert.equal(await controller.attach('c_pip'), true);
  html = renderCastStrip(controller.getState());
  assert.match(html, /data-cast-detach="c_pip"/);
  assert.match(html, /data-cast-diff="c_pip"/);
});

test('set presenter and narrator patch role overrides and demote the previous holder', async () => {
  const project = pipProject();
  const fake = fakeCastApi(project.cast, project.library);
  const controller = new CastStripController({ api: fake.api, chatId: 'chat_abcdefgh' });
  await controller.load();

  assert.equal(await controller.setPresenter('c_pip'), true);
  assert.equal(castRole(controller.entry('c_pip')), 'presenter');
  assert.equal(fake.calls.patchCast.length, 1);
  assert.deepEqual(fake.calls.patchCast[0], {
    chatId: 'chat_abcdefgh',
    castId: 'c_pip',
    patch: { overrides: { role: 'presenter' } },
  });

  assert.equal(await controller.setPresenter('c_bean'), true);
  assert.equal(castRole(controller.entry('c_bean')), 'presenter');
  assert.equal(castRole(controller.entry('c_pip')), 'mascot');
  assert.equal(fake.calls.patchCast.length, 3);
  assert.deepEqual(fake.calls.patchCast[1].patch.overrides, { role: 'mascot' });
  assert.deepEqual(fake.calls.patchCast[2].patch.overrides, { role: 'presenter' });

  assert.equal(await controller.setNarrator('c_pip'), true);
  assert.equal(castRole(controller.entry('c_pip')), 'narrator');
  assert.equal(castRole(controller.entry('c_bean')), 'presenter');
  assert.match(renderCastStrip(controller.getState()), /data-cast-narrator="c_pip" aria-pressed="true"/);
});

test('remove drops the project entry but keeps the library snapshot', async () => {
  const project = pipProject();
  const fake = fakeCastApi(project.cast, project.library);
  const controller = new CastStripController({ api: fake.api, chatId: 'chat_abcdefgh' });
  await controller.load();

  assert.equal(await controller.remove('c_pip'), true);
  assert.deepEqual(fake.calls.removeCast, [{ chatId: 'chat_abcdefgh', castId: 'c_pip' }]);
  assert.equal(controller.entry('c_pip'), undefined);
  assert.match(controller.state.message, /library character is kept/);
});

test('names and handles are escaped in chip and diff markup', () => {
  const unsafe = character({
    name: '<img src=x onerror=alert(1)>',
    summary: '<script>alert(1)</script>',
    handle: 'safe_handle',
  });
  const html = renderCastStrip({
    chatId: 'chat_abcdefgh',
    cast: [castEntry('c_safe_handle', unsafe)],
    library: [],
    loading: false,
    busy: false,
    message: '',
    messageError: false,
    diffCastId: null,
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;img src=x/);
  assert.equal(escapeHtml('<a href="x">'), '&lt;a href=&quot;x&quot;&gt;');
  assert.equal(formatDiffValue(['a', 'b']), 'a, b');
  assert.equal(formatDiffValue(null), '—');
});

test('autocompleteMentions matches handles case-insensitively and returns castIds', () => {
  const project = pipProject();
  const suggestions = autocompleteMentions('@PI', project.cast);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].handle, 'pip');
  assert.equal(suggestions[0].castId, 'c_pip');
  assert.equal(suggestions[0].characterId, 'chr_0123456789abcdef');
  assert.equal(suggestions[0].token, '@pip');

  assert.equal(autocompleteMentions('bean', project.cast)[0].castId, 'c_bean');
  assert.equal(autocompleteMentions('@ip', project.cast).length, 0);
  assert.equal(autocompleteMentions('@ip', project.cast, { allowSubstring: true })[0].castId, 'c_pip');
  assert.deepEqual(autocompleteMentions('@', project.cast).map(item => item.castId), ['c_pip', 'c_bean']);
  assert.equal(autocompleteMentions('@', project.cast, { limit: 1 }).length, 1);
});

test('mention parses every @handle and returns unique castIds plus unknowns', () => {
  const project = pipProject();
  const result = mention('Starring @pip and @Bean, not @ghost. Then @pip again.', project.cast);

  assert.deepEqual(result.castIds, ['c_pip', 'c_bean']);
  assert.deepEqual(result.unknown, ['ghost']);
  assert.equal(result.mentions.length, 4);
  assert.equal(result.mentions[0].handle, 'pip');
  assert.equal(result.mentions[0].known, true);
  assert.equal(result.mentions[1].handle, 'bean');
  assert.equal(result.mentions[2].known, false);
  assert.equal(result.mentions[2].castId, null);
  assert.equal(result.mentions[0].token, '@pip');
  assert.equal(result.mentions[0].start, 9);
  assert.equal(result.mentions[0].end, 13);
});

test('mention ignores email-like text and resolves library Character handles', () => {
  const bean = character({
    id: 'chr_fedcba9876543210',
    revision: 1,
    name: 'Bean',
    handle: 'bean',
    role: 'supporting',
  });
  const result = mention('write to pip@example.com or @Bean', [bean]);
  assert.deepEqual(result.castIds, ['c_bean']);
  assert.deepEqual(result.unknown, []);
  assert.equal(result.mentions.length, 1);
});

test('mention suggests the active handle at the caret', () => {
  const project = pipProject();
  const result = mention('Put @be in scene 2', project.cast, { caret: 7 });
  assert.equal(result.query, 'be');
  assert.equal(result.start, 4);
  assert.equal(result.end, 7);
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].castId, 'c_bean');

  const complete = completeMention('Put @be in scene 2', project.cast, { caret: 7 });
  assert.equal(complete.query, 'be');
  assert.deepEqual(complete.castIds, ['c_bean']);
  assert.equal(applyMention('Put @be in scene 2', complete.suggestions[0], complete), 'Put @bean in scene 2');
});

test('detached cast members are not suggested unless explicitly included', () => {
  const project = pipProject();
  const detached = { ...project.cast[0], detached: true };
  assert.deepEqual(autocompleteMentions('@pip', [detached]).map(item => item.castId), []);
  assert.deepEqual(
    autocompleteMentions('@pip', [detached], { includeDetached: true }).map(item => item.castId),
    ['c_pip'],
  );
  assert.deepEqual(mention('@pip', [detached]).castIds, ['c_pip']);
});

test('handle normalization and active mention ranges are bounded', () => {
  assert.equal(normalizeMentionHandle('@Pip'), 'pip');
  assert.equal(normalizeMentionHandle('bad handle'), null);
  assert.equal(normalizeMentionHandle('x'.repeat(33)), null);
  assert.deepEqual(findActiveMention('hello @pi'), { query: 'pi', start: 6, end: 9 });
  assert.deepEqual(findActiveMention('hello @pi', 9), { query: 'pi', start: 6, end: 9 });
  assert.equal(findActiveMention('hello @pi ', 10), null);
  assert.deepEqual(mentionCandidates([]), []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectNavigation } from '../src/project-navigation.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(search = '?package=pkg_active&view=super-easy') {
  let active = 'pkg_active';
  let dirty = false;
  const commits: Array<{ mode: string; search: string }> = [];
  const loads: string[] = [];
  const options = {
    search: () => search,
    packageId: () => active,
    flush: async () => {},
    hasUnsavedChanges: () => dirty,
    load: async (id: string) => { loads.push(id); active = id; },
    commit: (mode: 'easy' | 'advanced', next: string) => { commits.push({ mode, search: next }); search = next; },
  };
  return { options, commits, loads, setDirty: (value: boolean) => { dirty = value; }, active: () => active };
}

test('mode transitions await the save acknowledgment and preserve the current document', async () => {
  const f = fixture();
  const save = deferred();
  f.setDirty(true);
  f.options.flush = async () => { await save.promise; f.setDirty(false); };
  const navigation = createProjectNavigation(f.options);
  const transition = navigation.navigate('advanced');
  await Promise.resolve();
  assert.equal(f.commits.length, 0);
  save.resolve();
  await transition;
  assert.deepEqual(f.loads, [], 'same-project mode changes must not replace the document or its sidecar');
  assert.equal(new URLSearchParams(f.commits[0].search).get('package'), 'pkg_active');
  assert.equal(new URLSearchParams(f.commits[0].search).get('view'), 'editor');
});

test('an explicit active Easy package replaces the stale sample before the Editor opens', async () => {
  const f = fixture('?demo=1&view=super-easy');
  const load = deferred();
  const original = f.options.load;
  f.options.load = async id => { await load.promise; await original(id); };
  const navigation = createProjectNavigation(f.options);
  const transition = navigation.navigate('advanced', 'pkg_gallery_copy');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.commits.length, 0);
  assert.equal(f.active(), 'pkg_active');
  load.resolve();
  await transition;
  assert.equal(f.active(), 'pkg_gallery_copy');
  const params = new URLSearchParams(f.commits[0].search);
  assert.equal(params.get('package'), 'pkg_gallery_copy');
  assert.equal(params.get('demo'), '1');
  assert.equal(params.get('view'), 'editor');
});

test('failed saves, failed loads and wrong package identities never expose the Editor', async () => {
  const f = fixture();
  const navigation = createProjectNavigation(f.options);
  f.setDirty(true);
  await assert.rejects(navigation.navigate('advanced'), /not saved/);
  assert.deepEqual(f.loads, []);
  f.setDirty(false);
  f.options.load = async () => { throw new Error('HTTP 403'); };
  await assert.rejects(navigation.navigate('advanced', 'pkg_unavailable'), /403/);
  f.options.load = async () => {};
  await assert.rejects(navigation.navigate('advanced', 'pkg_wrong'), /did not load/);
  assert.equal(f.commits.length, 0);
  await navigation.navigate('advanced', 'pkg_active');
  assert.equal(f.commits.length, 1, 'a rejected transition must not poison later attempts');
});

test('Super Easy and Easy round trips retain exact project, conversation, production and guest scope', async () => {
  for (const route of ['view=super-easy', 'step=review']) {
    const f = fixture(`?demo=1&package=pkg_active&chat=chat_active123&production=prod_active&${route}`);
    const navigation = createProjectNavigation(f.options);
    await navigation.navigate('advanced');
    await navigation.navigate('easy');
    const params = new URLSearchParams(f.commits[1].search);
    assert.equal(params.get('package'), 'pkg_active');
    assert.equal(params.get('chat'), 'chat_active123');
    assert.equal(params.get('production'), 'prod_active');
    assert.equal(params.get('demo'), '1');
    assert.equal(params.get(route.split('=')[0]), route.split('=')[1]);
    assert.deepEqual(f.loads, []);
  }
});

test('serialized transitions cannot let an older package load overwrite the latest destination', async () => {
  const f = fixture();
  const load = deferred();
  const original = f.options.load;
  f.options.load = async id => { if (id === 'pkg_a') await load.promise; await original(id); };
  const navigation = createProjectNavigation(f.options);
  const first = navigation.navigate('advanced', 'pkg_a');
  const second = navigation.navigate('advanced', 'pkg_b');
  await Promise.resolve();
  assert.equal(f.commits.length, 0);
  load.resolve();
  await Promise.all([first, second]);
  assert.equal(f.active(), 'pkg_b');
  assert.deepEqual(f.loads, ['pkg_a', 'pkg_b']);
  assert.equal(new URLSearchParams(f.commits[1].search).get('package'), 'pkg_b');
});

test('a repeated click on the active view does not add a duplicate history entry', async () => {
  const f = fixture('?package=pkg_active&step=plan');
  let mode: 'easy' | 'advanced' = 'easy';
  const navigation = createProjectNavigation({
    ...f.options,
    currentMode: () => mode,
    commit: (next, search) => { mode = next; f.options.commit(next, search); },
  });
  await navigation.navigate('advanced');
  assert.equal(f.commits.length, 1);
  await navigation.navigate('advanced');
  assert.equal(f.commits.length, 1);
  assert.equal(f.loads.length, 0);
});

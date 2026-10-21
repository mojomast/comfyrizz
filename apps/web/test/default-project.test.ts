// PN07: the editor's first open. Pure functions plus an injected request, so no
// server, network, GPU or browser is involved.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BUNDLED_ACTIVITY,
  DEFAULT_EXAMPLE_DIR,
  DEFAULT_PACKAGE_ID,
  DEFAULT_PROJECT_TITLE,
  SEEDED_CHAT_ID,
  initialProjectActivity,
  initialProjectTarget,
  openInitialProject,
} from '../src/default-project.ts';

const packageJson = JSON.parse(readFileSync(new URL('../../../examples/pip-night-shift/package.json', import.meta.url), 'utf8'));
const timelineJson = JSON.parse(readFileSync(new URL('../../../examples/pip-night-shift/timeline.json', import.meta.url), 'utf8'));
const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Call = { url: string; init?: RequestInit };

function opener(response: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const adopted: Array<{ pkg: unknown; editor?: unknown }> = [];
  const errors: unknown[] = [];
  const open = (search: string, hasToken: boolean) => openInitialProject({
    search,
    hasToken,
    request: async (url, init) => {
      calls.push({ url, init });
      return await response();
    },
    onPackage: (pkg, editor) => adopted.push({ pkg, editor }),
    onError: error => errors.push(error),
  });
  return { calls, adopted, errors, open };
}

test('PN07: the bundled example matches the default ids and has a compiled timeline', () => {
  assert.equal(DEFAULT_PACKAGE_ID, packageJson.id);
  assert.equal(DEFAULT_PROJECT_TITLE, "Pip's Night Shift");
  assert.equal(packageJson.title, DEFAULT_PROJECT_TITLE);
  assert.equal(DEFAULT_EXAMPLE_DIR, 'examples/pip-night-shift');
  assert.equal(timelineJson.scenes.length, packageJson.scenes.length);
});

test('PN07: without a token the bundled package stays, whatever the query', async () => {
  assert.deepEqual(initialProjectTarget('', false), { source: 'bundled', packageId: null });
  assert.deepEqual(initialProjectTarget('?package=pkg_custom', false), { source: 'bundled', packageId: null });

  const standalone = opener(() => json({ package: { id: 'unexpected' } }));
  const result = await standalone.open('', false);
  assert.equal(result.source, 'bundled');
  assert.equal(result.packageId, null);
  assert.equal(result.chatId, undefined);
  assert.equal(result.activity, BUNDLED_ACTIVITY);
  assert.match(result.activity, /pip-night-shift/);
  assert.match(result.activity, /compiled timeline/);
  assert.doesNotMatch(result.activity, /launch-demo/);
  assert.equal(standalone.calls.length, 0);
  assert.equal(standalone.adopted.length, 0);

  const requestedWithoutToken = await standalone.open('?package=pkg_custom', false);
  assert.equal(requestedWithoutToken.source, 'bundled');
  assert.equal(requestedWithoutToken.packageId, null);
  assert.equal(standalone.calls.length, 0);
});

test('PN07: a token and no query opens the seeded project from the API', async () => {
  const seededEditor = { version: 1, captionOverrides: [] };
  const seeded = opener(() => json({ package: packageJson, revision: packageJson.revision, editor: seededEditor }));
  const result = await seeded.open('', true);

  assert.deepEqual(initialProjectTarget('', true), { source: 'seeded', packageId: DEFAULT_PACKAGE_ID });
  assert.equal(seeded.calls.length, 1);
  assert.equal(seeded.calls[0]?.url, `/api/package/${DEFAULT_PACKAGE_ID}`);
  assert.equal(seeded.adopted.length, 1);
  assert.equal((seeded.adopted[0]?.pkg as { id?: string }).id, packageJson.id);
  assert.deepEqual(seeded.adopted[0]?.editor, seededEditor);
  assert.equal(result.source, 'seeded');
  assert.equal(result.packageId, packageJson.id);
  assert.equal(result.chatId, SEEDED_CHAT_ID);
  assert.match(result.activity, /Opened Pip's Night Shift from the local server/);
  assert.match(result.activity, /pip-night-shift/);
  assert.doesNotMatch(result.activity, /launch-demo/);
});

test('PN07: ?package= still opens exactly the requested stored project', async () => {
  const requested = opener(() => json({ package: { id: 'pkg_custom', title: 'Custom' }, revision: 2 }));
  const result = await requested.open('?package=pkg_custom', true);

  assert.equal(requested.calls.length, 1);
  assert.equal(requested.calls[0]?.url, '/api/package/pkg_custom');
  assert.equal(result.source, 'requested');
  assert.equal(result.packageId, 'pkg_custom');
  assert.equal(result.chatId, undefined, 'only the seeded default borrows the demo chat');
  assert.equal(initialProjectActivity('requested', 'pkg_custom'), 'Opened requested package pkg_custom from the local server + compiled timeline');
});

test('PN07: a failed or malformed API response leaves the bundled package open', async () => {
  const missing = opener(() => json({ error: 'package not found' }, 404));
  const failed = await missing.open('', true);
  assert.equal(failed.source, 'bundled');
  assert.equal(failed.activity, BUNDLED_ACTIVITY);
  assert.equal(missing.adopted.length, 0);
  assert.equal(missing.errors.length, 1);

  const malformed = opener(() => json({ revision: 1 }));
  const empty = await malformed.open('', true);
  assert.equal(empty.source, 'bundled');
  assert.equal(malformed.adopted.length, 0);
  assert.equal(malformed.errors.length, 1);
});

test('a requested project can restore its explicitly linked conversation', async () => {
  const requested = opener(() => json({ package: { id: 'pkg_nrcu_episode2' }, revision: 1 }));
  assert.equal((await requested.open('?package=pkg_nrcu_episode2&chat=chat_nrcu_episode2', true)).chatId, 'chat_nrcu_episode2');
  assert.equal((await requested.open('?package=pkg_nrcu_episode2&chat=../invalid', true)).chatId, undefined);
});

test('project run defaults supply a finite starting budget without changing the package', async () => {
  const requested = opener(() => json({ package: { id: 'pkg_nrcu_episode2' }, runDefaults: { budgetUnits: 14.5 } }));
  assert.equal((await requested.open('?package=pkg_nrcu_episode2', true)).budgetUnits, 14.5);
  assert.deepEqual(requested.adopted[0]?.pkg, { id: 'pkg_nrcu_episode2' });
  const invalid = opener(() => json({ package: { id: 'pkg_other' }, runDefaults: { budgetUnits: -1 } }));
  assert.equal((await invalid.open('?package=pkg_other', true)).budgetUnits, undefined);
});

test('PN07: the shell boots Pip\'s Night Shift and keeps the seeded-chat fallback', () => {
  assert.match(mainSource, /examples\/pip-night-shift\/package\.json/);
  assert.match(mainSource, /examples\/pip-night-shift\/timeline\.json/);
  assert.doesNotMatch(mainSource, /examples\/launch-demo\/(package|timeline)\.json/);
  assert.match(mainSource, /await openInitialProject\(\{/);
  assert.match(mainSource, /hasToken: Boolean\(sessionToken\(\)\)/);
  assert.match(mainSource, /seededChatId = openedProject\.chatId \?\? null/);
  assert.equal((mainSource.match(/chatId: \(\) => projectChat\.conversationId \?\? seededChatId/g) ?? []).length, 2);
  assert.match(mainSource, /text: opened\.activity/);
  assert.doesNotMatch(mainSource, /openRequestedPackage/);
});

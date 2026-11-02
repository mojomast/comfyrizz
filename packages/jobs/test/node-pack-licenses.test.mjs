// SP10: every class_type in workflows/**/*.api.json maps to a node pack in
// docs/NODE_PACKS.md, and no active custom pack is copyleft. ComfyUI core is
// the GPL-3.0 runtime-cloned host, so it is allowed but never vendored.
//
// The test is pure: it reads the workflow JSON and the documentation table,
// then runs an in-memory graph through the same validator used for fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORKFLOWS = join(ROOT, 'workflows');
const DOC_PATH = join(ROOT, 'docs/NODE_PACKS.md');

// GPL, AGPL and LGPL are all copyleft. The host row is exempt because ComfyUI
// is cloned at runtime, never vendored or shipped.
const COPYLEFT_RE = /\b(?:A?GPL|LGPL)(?:[- ]?v?\d+(?:\.\d+)?)?(?:-only|-or-later)?\b/i;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const STATUSES = new Set(['host', 'active', 'banned']);

function markdownCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function tableAfter(markdown, heading) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  assert.notEqual(start, -1, `docs/NODE_PACKS.md is missing the ${heading} section`);
  let i = start + 1;
  while (i < lines.length && !lines[i].trim().startsWith('|')) i += 1;
  assert.ok(i < lines.length, `docs/NODE_PACKS.md is missing the table under ${heading}`);
  const header = markdownCells(lines[i]);
  i += 1;
  assert.match(lines[i].trim(), /^\|[\s:|-]+\|$/, `docs/NODE_PACKS.md has no table separator under ${heading}`);
  i += 1;
  const rows = [];
  for (; i < lines.length && lines[i].trim().startsWith('|'); i += 1) {
    const values = markdownCells(lines[i]);
    assert.equal(values.length, header.length, `docs/NODE_PACKS.md has ${values.length} cells for ${header.length} columns under ${heading}`);
    rows.push(Object.fromEntries(header.map((column, index) => [column, values[index]])));
  }
  assert.ok(rows.length > 0, `docs/NODE_PACKS.md has an empty table under ${heading}`);
  return rows;
}

function readDocs() {
  const markdown = readFileSync(DOC_PATH, 'utf8');
  return {
    markdown,
    packs: tableAfter(markdown, '## Node packs'),
    classTypes: tableAfter(markdown, '## Class type to pack map'),
  };
}

function workflowFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...workflowFiles(path));
    else if (entry.name.endsWith('.api.json')) files.push(path);
  }
  return files;
}

function graphClassTypes(graph) {
  assert.equal(typeof graph, 'object');
  assert.notEqual(graph, null);
  assert.equal(Array.isArray(graph), false);
  return Object.entries(graph).map(([id, node]) => {
    assert.equal(typeof node?.class_type, 'string', `node ${id} has no class_type`);
    return { id, classType: node.class_type };
  });
}

function validateGraph(graph, { packs, classTypes }) {
  const errors = [];
  const packByName = new Map(packs.map((pack) => [pack.Pack, pack]));
  const packByClass = new Map(classTypes.map((row) => [row['Class type'], row.Pack]));
  const usedPacks = new Set();

  for (const { id, classType } of graphClassTypes(graph)) {
    const packName = packByClass.get(classType);
    if (!packName) {
      errors.push(`node ${id}: unknown class_type ${classType}`);
      continue;
    }
    const pack = packByName.get(packName);
    if (!pack) {
      errors.push(`node ${id}: class_type ${classType} maps to unknown pack ${packName}`);
      continue;
    }
    usedPacks.add(packName);
    if (pack.Status === 'banned') {
      errors.push(`node ${id}: class_type ${classType} uses banned pack ${packName}`);
    } else if (pack.Status === 'active' && COPYLEFT_RE.test(pack['SPDX licence'])) {
      errors.push(`node ${id}: class_type ${classType} uses copyleft pack ${packName} (${pack['SPDX licence']})`);
    }
  }

  return { errors, usedPacks };
}

function activeOpenProvenance(packs) {
  return packs
    .filter((pack) => pack.Status === 'active')
    .filter((pack) => [pack.URL, pack.Commit, pack['SPDX licence']]
      .some((value) => value === 'UNPINNED' || value === 'UNVERIFIED'))
    .map((pack) => pack.Pack);
}

const OPEN_PROVENANCE = (() => {
  try {
    return activeOpenProvenance(readDocs().packs);
  } catch {
    return [];
  }
})();

test.todo(`pin active node packs with UNPINNED or UNVERIFIED provenance${OPEN_PROVENANCE.length ? `: ${OPEN_PROVENANCE.join(', ')}` : ''}`);

test('the pack table records a URL, pin, SPDX licence and status for every pack', () => {
  const { packs } = readDocs();
  for (const pack of packs) {
    assert.ok(pack.Pack, 'a pack row has no name');
    assert.ok(pack.URL, `${pack.Pack} has no URL cell`);
    assert.ok(pack.Commit, `${pack.Pack} has no commit cell`);
    assert.ok(pack['SPDX licence'], `${pack.Pack} has no licence cell`);
    assert.ok(STATUSES.has(pack.Status), `${pack.Pack} has unknown status ${pack.Status}`);
    if (pack.Commit !== 'UNPINNED') assert.match(pack.Commit, COMMIT_RE, `${pack.Pack} has a non-hex commit ${pack.Commit}`);
    if (pack.URL !== 'UNVERIFIED') assert.match(pack.URL, /^https:\/\//, `${pack.Pack} has no https URL`);
  }
});

test('ComfyUI core is the runtime-cloned GPL-3.0 host, not a vendored pack', () => {
  const { packs } = readDocs();
  const core = packs.find((pack) => pack.Pack === 'comfyui-core');
  assert.ok(core, 'the core host row is missing');
  assert.equal(core.Status, 'host');
  assert.equal(core['SPDX licence'], 'GPL-3.0');
  assert.equal(core.Commit, 'd52a7a5ef60b36062f7c3c69bd774f4c98b56eb0');
  assert.match(core.URL, /^https:\/\/github\.com\/Comfy-Org\/ComfyUI$/);
  assert.match(core.Notes, /runtime-cloned/);
  assert.match(core.Notes, /not vendored/);
});

test('the class type map names an existing pack and maps each class once', () => {
  const { packs, classTypes } = readDocs();
  const packNames = new Set(packs.map((pack) => pack.Pack));
  const seen = new Set();
  for (const row of classTypes) {
    assert.ok(row['Class type'], 'a class type row is empty');
    assert.ok(packNames.has(row.Pack), `${row['Class type']} maps to unknown pack ${row.Pack}`);
    assert.equal(seen.has(row['Class type']), false, `${row['Class type']} is mapped more than once`);
    seen.add(row['Class type']);
  }
});

test('every shipped workflow class_type is mapped to a pack', () => {
  const docs = readDocs();
  const unknown = [];
  for (const file of workflowFiles(WORKFLOWS)) {
    const graph = JSON.parse(readFileSync(file, 'utf8'));
    const { errors } = validateGraph(graph, docs);
    if (errors.length) unknown.push(`${relative(ROOT, file)}: ${errors.join('; ')}`);
  }
  assert.deepEqual(unknown, []);
});

test('the shipped workflows pass the licence gate', () => {
  const docs = readDocs();
  for (const file of workflowFiles(WORKFLOWS)) {
    const graph = JSON.parse(readFileSync(file, 'utf8'));
    const { errors } = validateGraph(graph, docs);
    assert.deepEqual(errors, [], `${relative(ROOT, file)} fails the node-pack gate`);
  }
});

test('a fixture graph using a GPL, AGPL or LGPL active pack fails', () => {
  for (const licence of ['GPL-3.0', 'AGPL-3.0-only', 'LGPL-2.1-or-later']) {
    const packs = [{ Pack: 'fixture-copyleft', URL: 'https://fixture.invalid/pack', Commit: 'UNPINNED', 'SPDX licence': licence, Status: 'active', Notes: '' }];
    const classTypes = [{ 'Class type': 'FixtureCopyleftNode', Pack: 'fixture-copyleft' }];
    const { errors } = validateGraph({ 1: { class_type: 'FixtureCopyleftNode', inputs: {} } }, { packs, classTypes });
    assert.ok(errors.some((error) => error.includes('copyleft') && error.includes(licence)), `the ${licence} fixture was accepted`);
  }
});

test('the licence gate accepts an MIT active pack', () => {
  const packs = [{ Pack: 'fixture-mit', URL: 'https://fixture.invalid/pack', Commit: 'UNPINNED', 'SPDX licence': 'MIT', Status: 'active', Notes: '' }];
  const classTypes = [{ 'Class type': 'FixtureMitNode', Pack: 'fixture-mit' }];
  const { errors } = validateGraph({ 1: { class_type: 'FixtureMitNode', inputs: {} } }, { packs, classTypes });
  assert.deepEqual(errors, []);
});

test('a fixture graph using a banned pack fails', () => {
  const packs = [{ Pack: 'fixture-banned', URL: 'https://fixture.invalid/pack', Commit: 'UNPINNED', 'SPDX licence': 'GPL-3.0', Status: 'banned', Notes: '' }];
  const classTypes = [{ 'Class type': 'FixtureBannedNode', Pack: 'fixture-banned' }];
  const { errors } = validateGraph({ 1: { class_type: 'FixtureBannedNode', inputs: {} } }, { packs, classTypes });
  assert.ok(errors.some((error) => error.includes('banned') && error.includes('fixture-banned')));
});

test('a fixture graph using an unknown class_type fails', () => {
  const { packs, classTypes } = readDocs();
  const { errors } = validateGraph({ 1: { class_type: 'NotInTheTable', inputs: {} } }, { packs, classTypes });
  assert.ok(errors.some((error) => error.includes('unknown class_type NotInTheTable')));
});

test('the removed Stubelius template source is recorded as a banned GPL-3.0 pack', () => {
  const { packs, classTypes } = readDocs();
  const banned = packs.find((pack) => pack.Pack === 'comfyui-motion-previs-studio');
  assert.ok(banned, 'the banned Stubelius source is missing from the pack table');
  assert.equal(banned.Status, 'banned');
  assert.equal(banned.URL, 'https://github.com/navarisun1982/comfyui-motion-previs-studio');
  assert.equal(banned.Commit, 'dd93095d21d15c56cb2e2baf4ec0118e849c7de5');
  assert.equal(banned['SPDX licence'], 'GPL-3.0');
  assert.match(banned.Notes, /workflows\/templates\/ltx25_stubelius\.api\.json/);
  assert.equal(classTypes.some((row) => row.Pack === banned.Pack), false, 'a banned pack must not be mapped to a class type');
});

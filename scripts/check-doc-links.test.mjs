import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

const SPEC_DOCS = [
  'docs/PLAN.md',
  'docs/SPEC.md',
  'docs/specs/ITERATIVE_PRODUCTION_AGENT.md',
  'docs/research/ITERATIVE_PRODUCTION_WORKFLOW_20261022.md',
];

const CANONICAL_VOICE_DOC = 'docs/VOICE_GENERATION.md';
const REMOVED_VOICE_DOC = 'VOICE_CASTING_STANDARD.md';

function readDoc(file) {
  return readFileSync(join(REPO_ROOT, file), 'utf8');
}

function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '');
}

function extractLinks(text) {
  const clean = stripCode(text);
  const links = [];
  const inline = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*["')])?\s*\)/g;
  for (const match of clean.matchAll(inline)) links.push(match[1]);

  const reference = /^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm;
  for (const match of clean.matchAll(reference)) links.push(match[1]);

  return links;
}

function isExternal(link) {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(link) ||
    link.startsWith('//') ||
    link.startsWith('#')
  );
}

function resolveLink(fromFile, link) {
  const withoutFragment = link.split('#')[0].split('?')[0];
  if (!withoutFragment) return null;
  const decoded = decodeURIComponent(withoutFragment);
  return resolve(dirname(join(REPO_ROOT, fromFile)), decoded);
}

test('the four specification documents exist', () => {
  for (const file of SPEC_DOCS) {
    assert.ok(existsSync(join(REPO_ROOT, file)), `missing specification document: ${file}`);
  }
});

test('all relative links in the specification documents resolve', () => {
  const broken = [];
  for (const file of SPEC_DOCS) {
    for (const link of extractLinks(readDoc(file))) {
      if (isExternal(link)) continue;
      const target = resolveLink(file, link);
      if (target && !existsSync(target)) {
        broken.push(`${file} -> ${link} (${relative(REPO_ROOT, target)})`);
      }
    }
  }
  assert.deepEqual(broken, []);
});

test('the voice standard points at the canonical generation guide', () => {
  const spec = readDoc('docs/specs/ITERATIVE_PRODUCTION_AGENT.md');
  const research = readDoc('docs/research/ITERATIVE_PRODUCTION_WORKFLOW_20261022.md');
  for (const [file, text] of [
    ['docs/specs/ITERATIVE_PRODUCTION_AGENT.md', spec],
    ['docs/research/ITERATIVE_PRODUCTION_WORKFLOW_20261022.md', research],
  ]) {
    assert.ok(!text.includes(REMOVED_VOICE_DOC), `${file} still references the removed voice document`);
    const targets = extractLinks(text)
      .filter((link) => !isExternal(link))
      .map((link) => resolveLink(file, link))
      .filter(Boolean);
    assert.ok(
      targets.includes(resolve(REPO_ROOT, CANONICAL_VOICE_DOC)),
      `${file} does not link to ${CANONICAL_VOICE_DOC}`,
    );
  }
});

test('the spec records the audited baseline', () => {
  const spec = readDoc('docs/specs/ITERATIVE_PRODUCTION_AGENT.md');
  assert.match(spec, /37f8f73/);
  assert.match(spec, /baseline/i);
});

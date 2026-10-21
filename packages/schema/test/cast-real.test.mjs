// CCL5b: cast[].kind defaults to fictional and real_authorized requires a consentRef.
// Old packages stay valid, and both language bindings read the same conditional schema.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyDefaults, loadSchema, validatePackage } from '../src/index.mjs';

const minimal = JSON.parse(readFileSync(new URL('../fixtures/valid/minimal.json', import.meta.url)));
const mascot = JSON.parse(readFileSync(new URL('../fixtures/valid/cast-mascot.json', import.meta.url)));

const clone = (doc) => structuredClone(doc);
const realMember = (overrides = {}) => ({ ...clone(mascot.cast[0]), kind: 'real_authorized', consentRef: 'consent_0123456789abcdef', ...overrides });

test('old packages without cast kind or consentRef stay valid', () => {
  for (const doc of [minimal, mascot]) {
    const result = validatePackage(clone(doc));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.equal(result.schemaOk, true);
  }
});

test('cast[].kind is optional and defaults to fictional', () => {
  const pkg = clone(mascot);
  assert.equal(pkg.cast[0].kind, undefined);
  assert.equal(validatePackage(pkg).valid, true);

  const normalized = applyDefaults(pkg, loadSchema());
  assert.equal(normalized.cast[0].kind, 'fictional');

  const explicit = clone(mascot);
  explicit.cast[0].kind = 'fictional';
  assert.equal(validatePackage(explicit).valid, true);
});

test('real_authorized requires a consentRef', () => {
  const withConsent = clone(mascot);
  withConsent.cast[0] = realMember();
  const valid = validatePackage(withConsent);
  assert.equal(valid.valid, true, JSON.stringify(valid.errors));

  const missing = clone(mascot);
  missing.cast[0] = realMember();
  delete missing.cast[0].consentRef;
  const invalid = validatePackage(missing);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.schemaOk, false);
  assert.ok(invalid.errors.some((entry) => entry.source === 'schema' && entry.path === '/cast/0'));
});

test('consentRef is a non-empty, non-blank reference', () => {
  for (const consentRef of ['', '   ', 7, null]) {
    const pkg = clone(mascot);
    pkg.cast[0] = realMember({ consentRef });
    const result = validatePackage(pkg);
    assert.equal(result.valid, false, `consentRef ${JSON.stringify(consentRef)} should be rejected`);
    assert.equal(result.schemaOk, false);
  }
});

test('only fictional and real_authorized are accepted', () => {
  for (const kind of ['Fictional', 'real', 'person', 'other', '', 7, null]) {
    const pkg = clone(mascot);
    pkg.cast[0] = { ...clone(mascot.cast[0]), kind };
    const result = validatePackage(pkg);
    assert.equal(result.valid, false, `kind ${JSON.stringify(kind)} should be rejected`);
    assert.equal(result.schemaOk, false);
  }
});

test('a fictional member may omit consentRef and a real member may keep its voice', () => {
  const pkg = clone(mascot);
  pkg.cast[0] = {
    ...realMember(),
    voice: { engine: 'kokoro', voice: 'am_michael', speed: 1.02 },
  };
  pkg.scenes[0].speaker = 'c_pip';
  assert.equal(validatePackage(pkg).valid, true, JSON.stringify(validatePackage(pkg).errors));
});

function findPython() {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const candidates = [process.env.COMFYRIZZ_PYTHON, `${root}.venv/bin/python`, 'python3'].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import jsonschema'], { encoding: 'utf8' });
    if (probe.status === 0) return { candidate, root };
  }
  return null;
}

test('JavaScript and Python validators agree on cast kind and consentRef', {
  skip: findPython() ? false : 'no python with jsonschema found (set COMFYRIZZ_PYTHON)',
}, () => {
  const { candidate, root } = findPython();
  const docs = [];

  const real = clone(mascot);
  real.cast[0] = realMember();
  docs.push(real);

  const missingConsent = clone(mascot);
  missingConsent.cast[0] = realMember();
  delete missingConsent.cast[0].consentRef;
  docs.push(missingConsent);

  const blankConsent = clone(mascot);
  blankConsent.cast[0] = realMember({ consentRef: '   ' });
  docs.push(blankConsent);

  const badKind = clone(mascot);
  badKind.cast[0].kind = 'real';
  docs.push(badKind);

  const explicitFictional = clone(mascot);
  explicitFictional.cast[0].kind = 'fictional';
  docs.push(explicitFictional);

  const oldPackage = clone(minimal);
  docs.push(oldPackage);

  const oldCastPackage = clone(mascot);
  docs.push(oldCastPackage);

  const run = spawnSync(
    candidate,
    ['-c', [
      'import sys, json',
      'from comfyrizz_pipeline.schema import validate_package, apply_defaults',
      'docs = json.load(sys.stdin)',
      'print(json.dumps({"reports": [validate_package(p) for p in docs], "defaults": [apply_defaults(p) for p in docs]}))',
    ].join('\n')],
    {
      input: JSON.stringify(docs),
      encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: `${root}pipeline-py` },
    },
  );
  assert.equal(run.status, 0, run.stderr);

  const fromPython = JSON.parse(run.stdout);
  fromPython.reports.forEach((py, index) => {
    const js = validatePackage(docs[index]);
    assert.equal(py.valid, js.valid, `case ${index} valid`);
    assert.equal(py.schemaOk, js.schemaOk, `case ${index} schemaOk`);
    const semantic = (report) => report.errors.filter((entry) => entry.source === 'semantic').map((entry) => entry.code + entry.path).sort();
    assert.deepEqual(semantic(py), semantic(js), `case ${index} semantic`);
    assert.deepEqual(fromPython.defaults[index], applyDefaults(clone(docs[index]), loadSchema()), `case ${index} defaults`);
  });
});

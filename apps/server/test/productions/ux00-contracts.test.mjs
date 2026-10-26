// UX00: first-slice shared contracts (admission, binding, mutation scope,
// media tickets) and the start/cancel/select/revert/export entry-point matrix.
//
// Fixtures live in test/fixtures/ux00 so the agent and web packages can read
// the same cases. Local only: no backend, provider or network.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createApp } from '../../src/app.mjs';
import { createMediaTickets, mediaIdFor } from '../../src/media-range.mjs';
import {
  ADMISSION_ENTRY_POINTS,
  ADMISSION_REFUSALS,
  ADMITTING_INTENTS,
  MEDIA_ID_PATTERN,
  MEDIA_SOURCE_KINDS,
  PRODUCTION_INTENTS,
  admissionCommandId,
  admissionRefusal,
  bindingRefusal,
  isLegacyBudgetRefusal,
  mediaSourceKey,
  resolveProductionBinding,
  ticketExpiryState,
  validateAdmissionRefusal,
  validateBoundAdmission,
  validateMediaSource,
  validateMediaTicket,
} from '../../src/productions/contract.mjs';
import {
  MUTATION_REFUSAL_CODES,
  SCOPE_ID_KINDS,
  SCOPE_ID_PATTERNS,
  normalizeTargetSet,
  scopeIdKind,
  targetSetAllows,
  validateIterationScope,
} from '../../src/productions/iteration-scope.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const fixture = (name) => JSON.parse(readFileSync(join(here, '..', 'fixtures', 'ux00', name), 'utf8'));
const admission = fixture('admission.json');
const scope = fixture('scope.json');
const media = fixture('media.json');
const matrix = fixture('entry-points.json');

function codes(result) {
  return result.errors.map((error) => error.code);
}

function assertCodes(result, expected, label) {
  assert.equal(result.ok, false, `${label} should be invalid`);
  for (const code of expected) {
    assert.ok(codes(result).includes(code), `${label} should report ${code}; got ${JSON.stringify(result.errors)}`);
  }
  for (const error of result.errors) assert.ok(error.path.startsWith('/'), `${label} error path ${error.path}`);
}

// --- admission -------------------------------------------------------------

test('UX00 admission: fixture authorities validate and caller authority is refused', () => {
  for (const { name, value } of admission.boundAdmission.valid) {
    assert.deepEqual(validateBoundAdmission(value), { ok: true, errors: [] }, name);
  }
  for (const { name, value, codes: expected } of admission.boundAdmission.invalid) {
    assertCodes(validateBoundAdmission(value), expected, name);
  }
});

test('UX00 admission: refusal bodies are typed and never look started', () => {
  for (const { name, value } of admission.refusals.valid) {
    assert.deepEqual(validateAdmissionRefusal(value), { ok: true, errors: [] }, name);
  }
  for (const { name, value, codes: expected } of admission.refusals.invalid) {
    assertCodes(validateAdmissionRefusal(value), expected, name);
  }
  for (const { name, value, legacy } of admission.refusals.legacyBudget) {
    assert.equal(isLegacyBudgetRefusal(value), legacy, name);
  }
});

test('UX00 admission: the refusal builder only emits valid refusals', () => {
  for (const code of Object.keys(ADMISSION_REFUSALS)) {
    const details = code === 'PRODUCTION_NOT_ACTIVE' ? { intent: 'paused', entryPoint: 'run.start' } : { entryPoint: 'run.start' };
    const body = admissionRefusal(code, `refused: ${code}`, details);
    assert.equal(body.status, ADMISSION_REFUSALS[code]);
    assert.deepEqual(validateAdmissionRefusal(body), { ok: true, errors: [] }, code);
  }
  assert.throws(() => admissionRefusal('NOT_A_CODE', 'x'), TypeError);
  assert.throws(() => admissionRefusal('RUN_BUSY', 'x', { runId: 'run_1' }), TypeError);
  assert.throws(() => admissionRefusal('RUN_BUSY', ''), TypeError);
});

test('UX00 admission: only active intent admits, and every other intent has a refusal', () => {
  assert.deepEqual([...ADMITTING_INTENTS], ['active']);
  for (const intent of PRODUCTION_INTENTS) {
    const refusal = bindingRefusal({ state: 'bound', productionId: 'prod_x', source: 'store', intent, revision: 1 }, 'pipeline.start');
    if (intent === 'active') assert.equal(refusal, null);
    else {
      assert.equal(refusal.code, 'PRODUCTION_NOT_ACTIVE');
      assert.equal(refusal.intent, intent);
      assert.deepEqual(validateAdmissionRefusal(refusal), { ok: true, errors: [] });
    }
  }
});

test('UX00 admission: production binding fixtures (unbound compatibility)', () => {
  for (const { name, pkg, productions, expected, refusal } of admission.binding) {
    const binding = resolveProductionBinding(pkg, productions);
    assert.deepEqual(binding, expected, name);
    const refused = bindingRefusal(binding, 'run.start');
    assert.equal(refused?.code ?? null, refusal, name);
    if (refused) assert.deepEqual(validateAdmissionRefusal(refused), { ok: true, errors: [] }, name);
  }
  assert.deepEqual(resolveProductionBinding(null, []), { state: 'unbound' });
  assert.deepEqual(resolveProductionBinding({ id: 'pkg_x' }, undefined), { state: 'unbound' });
});

test('UX00 admission: the command id matches the one run.mjs already commits', () => {
  const authority = { productionId: 'prod_x', planId: 'plan_x', planHash: 'a'.repeat(64), actionId: 'act_x' };
  assert.equal(admissionCommandId(authority), `run-start:${'a'.repeat(64)}:act_x`);
  const runSource = readFileSync(join(repoRoot, 'apps/server/src/run.mjs'), 'utf8');
  assert.ok(runSource.includes('const commandId = `run-start:${verdict.planHash}:${verdict.actionId}`;'),
    'run.mjs consumption id drifted from admissionCommandId');
});

function httpClient(server, token) {
  const { port } = server.address();
  return (method, path, body) => new Promise((resolveCall, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        'x-comfyrizz-token': token,
        host: `127.0.0.1:${port}`,
        origin: `http://127.0.0.1:${port}`,
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolveCall({ status: response.statusCode, json: text ? JSON.parse(text) : null });
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

test('UX00 admission: live mounted /api/run refusals already satisfy the frozen shape', async (t) => {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-ux00-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  let backendCalls = 0;
  const token = 'ux00-token-0123456789abcdef';
  const app = createApp({
    token,
    runtimeDir,
    backendFactory: async () => { backendCalls += 1; throw new Error('no backend in this test'); },
    render: async () => ({ output: 'none', bytes: 0, frames: 0, hash: 'none' }),
  });
  const server = createServer(app.handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    app.close();
    await new Promise((done) => server.close(done));
  });
  const call = httpClient(server, token);
  const pkg = { id: 'pkg_ux00_bound', schema: 'comfyrizz.package/1', productionId: 'prod_ux00_missing', assets: {}, scenes: [] };
  const authority = { productionId: 'prod_ux00_missing', planId: 'plan_x', planHash: 'a'.repeat(64), actionId: 'act_x' };

  const cases = [
    { body: { backendId: 'colab', package: pkg, budgetUnits: 100, approved: true }, code: 'BOUND_AUTHORITY_REQUIRED' },
    { body: { backendId: 'colab', package: pkg, authority, expected: { productionRevision: 0 } }, code: 'PRODUCTION_NOT_FOUND' },
    { body: { backendId: 'colab', package: pkg, authority: { ...authority, productionId: 'prod_other' }, expected: { productionRevision: 0 } }, code: 'PRODUCTION_MISMATCH' },
  ];
  for (const { body, code } of cases) {
    const refused = await call('POST', '/api/run', body);
    assert.equal(refused.json.code, code);
    assert.equal(refused.status, ADMISSION_REFUSALS[code], code);
    assert.deepEqual(validateAdmissionRefusal(refused.json), { ok: true, errors: [] }, code);
  }
  assert.equal(backendCalls, 0, 'a refused start must not reach a backend');
});

// --- mutation scope ---------------------------------------------------------

test('UX00 scope: id kinds classify named and numeric ids', () => {
  const seen = new Set();
  for (const { id, kind } of scope.ids) {
    assert.equal(scopeIdKind(id), kind, id);
    if (kind) seen.add(kind);
  }
  assert.deepEqual([...seen].sort(), [...SCOPE_ID_KINDS].sort(), 'every id kind has a fixture');
  assert.equal(scopeIdKind(42), null);
});

test('UX00 scope: shot, asset and cast patterns are the package-schema patterns', () => {
  const schema = JSON.parse(readFileSync(join(repoRoot, 'packages/schema/package-v1.schema.json'), 'utf8'));
  assert.equal(SCOPE_ID_PATTERNS.shot.source, schema.$defs.sceneId.pattern);
  assert.equal(SCOPE_ID_PATTERNS.asset.source, schema.$defs.assetId.pattern);
  assert.equal(SCOPE_ID_PATTERNS.cast.source, schema.$defs.castId.pattern);
  assert.equal(SCOPE_ID_PATTERNS.package.source, schema.properties.id.pattern);
});

test('UX00 scope: absent, empty and scoped target sets', () => {
  for (const entry of scope.targetSets) {
    const raw = entry.absent ? undefined : entry.value;
    if (entry.error) {
      assert.throws(() => normalizeTargetSet(raw), (error) => error.code === 'ITERATION_SCOPE_INVALID' && error.field === entry.error, entry.name);
      continue;
    }
    const set = normalizeTargetSet(raw);
    assert.equal(set.mode, entry.mode, entry.name);
    assert.ok(Object.isFrozen(set), entry.name);
    for (const { target, expected } of entry.allows ?? []) {
      assert.equal(targetSetAllows(set, target), expected, `${entry.name}: ${JSON.stringify(target)}`);
    }
  }
  assert.equal(normalizeTargetSet(null).mode, 'unscoped');
  assert.equal(targetSetAllows(normalizeTargetSet(undefined), {}), false, 'an unresolved target is never allowed');
});

test('UX00 scope: sourceRevision is optional and old scopes normalize unchanged', () => {
  for (const { name, value, normalized } of scope.iterationScopes.valid) {
    assert.deepEqual(validateIterationScope(value), normalized, name);
  }
  for (const { name, value, field } of scope.iterationScopes.invalid) {
    assert.throws(() => validateIterationScope(value), (error) => error.code === 'ITERATION_SCOPE_INVALID' && error.field === field, name);
  }
});

test('UX00 scope: one mutation refusal vocabulary reusing existing codes', () => {
  assert.equal(new Set(MUTATION_REFUSAL_CODES).size, MUTATION_REFUSAL_CODES.length);
  assert.ok(MUTATION_REFUSAL_CODES.includes('REVISION_CONFLICT'));
  assert.ok(MUTATION_REFUSAL_CODES.includes('ITERATION_SHOT_LOCKED'));
  assert.ok(MUTATION_REFUSAL_CODES.includes('PRODUCTION_NOT_ACTIVE'));
  assert.ok(Object.hasOwn(ADMISSION_REFUSALS, 'PRODUCTION_NOT_ACTIVE'), 'admission and mutation share the not-active code');
});

// --- media ------------------------------------------------------------------

test('UX00 media: source identity fixtures', () => {
  for (const { name, value } of media.sources.valid) {
    assert.deepEqual(validateMediaSource(value), { ok: true, errors: [] }, name);
  }
  for (const { name, value, codes: expected } of media.sources.invalid) {
    assertCodes(validateMediaSource(value), expected, name);
  }
  const kinds = new Set(media.sources.valid.map(({ value }) => value.kind));
  assert.deepEqual([...kinds].sort(), [...MEDIA_SOURCE_KINDS].sort(), 'every source kind has a fixture');
});

test('UX00 media: ticket fixtures and expiry states', () => {
  for (const { name, value } of media.tickets.valid) {
    assert.deepEqual(validateMediaTicket(value), { ok: true, errors: [] }, name);
  }
  for (const { name, value, codes: expected } of media.tickets.invalid) {
    assertCodes(validateMediaTicket(value), expected, name);
  }
  for (const { name, ticket, now, state } of media.expiry) {
    assert.equal(ticketExpiryState(ticket, Date.parse(now)), state, name);
  }
});

test('UX00 media: source keys ignore property order and separate sources', () => {
  for (const [left, right] of media.sameKey) assert.equal(mediaSourceKey(left), mediaSourceKey(right));
  for (const [left, right] of media.differentKey) assert.notEqual(mediaSourceKey(left), mediaSourceKey(right));
});

test('UX00 media: the live ticket minter satisfies the ticket contract', () => {
  let now = Date.parse('2026-10-26T12:00:00.000Z');
  const tickets = createMediaTickets({ now: () => now });
  const minted = tickets.mint('fixture.mp4', { artifactId: 'art_ux00' });
  assert.deepEqual(validateMediaTicket(minted), { ok: true, errors: [] });
  assert.match(minted.mediaId, MEDIA_ID_PATTERN);
  assert.match(mediaIdFor('anything'), MEDIA_ID_PATTERN);
  assert.equal(ticketExpiryState(minted, now), 'fresh');
  now = Date.parse(minted.expiresAt);
  assert.equal(ticketExpiryState(minted, now), 'expired');
  assert.equal(tickets.resolve(minted.ticket), null, 'the minter also refuses the expired ticket');
});

// --- entry-point matrix -----------------------------------------------------

const VERBS = ['start', 'cancel', 'select', 'revert', 'export'];
const BINDINGS = ['resolved', 'url', 'unwired', 'none'];
const AUTHORITIES = ['journal', 'command', 'boolean', 'gate', 'none'];
const IDEMPOTENCY = ['action', 'command', 'revision', 'none'];

test('UX00 entry points: every row is well-formed and still points at live code', () => {
  const ids = new Set();
  const sources = new Map();
  const source = (file) => {
    if (!sources.has(file)) {
      const path = join(repoRoot, file);
      assert.ok(existsSync(path), `${file} exists`);
      sources.set(file, readFileSync(path, 'utf8'));
    }
    return sources.get(file);
  };
  for (const entry of matrix.entries) {
    assert.ok(!ids.has(entry.id), `duplicate entry ${entry.id}`);
    ids.add(entry.id);
    assert.ok(VERBS.includes(entry.verb), `${entry.id} verb`);
    assert.ok(BINDINGS.includes(entry.binding), `${entry.id} binding`);
    assert.ok(AUTHORITIES.includes(entry.authority), `${entry.id} authority`);
    assert.ok(IDEMPOTENCY.includes(entry.idempotency), `${entry.id} idempotency`);
    assert.equal(typeof entry.legacy, 'boolean', `${entry.id} legacy`);
    assert.match(entry.owner, /^UX\d{2}$/, `${entry.id} owner`);
    assert.ok(typeof entry.gap === 'string' && entry.gap.length > 0, `${entry.id} gap`);
    if (entry.admissionEntryPoint !== null) {
      assert.equal(entry.verb, 'start', `${entry.id} only starts carry an admission entry point`);
      assert.ok(ADMISSION_ENTRY_POINTS.includes(entry.admissionEntryPoint), `${entry.id} admission entry point`);
    }
    for (const ref of [entry.handler, ...entry.callers]) {
      assert.ok(source(ref.file).includes(ref.symbol), `${entry.id}: ${ref.file} no longer contains ${JSON.stringify(ref.symbol)}`);
    }
  }
  for (const verb of VERBS) assert.ok(matrix.entries.some((entry) => entry.verb === verb), `matrix covers ${verb}`);
  for (const point of ADMISSION_ENTRY_POINTS) {
    assert.ok(matrix.entries.some((entry) => entry.admissionEntryPoint === point), `admission entry point ${point} is in the matrix`);
  }
});

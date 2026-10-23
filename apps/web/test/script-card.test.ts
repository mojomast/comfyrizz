// IP43: the treatment/script/shot-list card.
//
// The card is a pure view over a production snapshot. Every edit builds an
// `artifact.attach` command for IP18's single command path; it never mutates a
// production record or calls a backend. An approved shot is locked: its content
// cannot be edited, removed or moved, even while the prose around it changes.
//
// The tests use plain snapshots and a fake command client. There is no DOM,
// network, Google Colab session or model call.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCRIPT_ARTIFACT_KIND,
  SCRIPT_CARD_SCHEMA,
  SCRIPT_COMMAND_KIND,
  addShot,
  editScript,
  editShot,
  editTreatment,
  emptyScriptCard,
  errorScriptCard,
  isShotLocked,
  loadingScriptCard,
  readScriptCard,
  removeShot,
  renderScriptCard,
  reorderShots,
  sendScriptEdit,
} from '../src/productions/cards/script-card.ts';

const PRODUCTION_ID = 'prod_0123456789abcdef01234567';

function shot(id, overrides = {}) {
  return {
    id,
    title: `Shot ${id}`,
    description: `Action for ${id}`,
    dialogue: '',
    ...overrides,
  };
}

function production(overrides = {}) {
  return {
    schema: 'comfyrizz.production/v1',
    id: PRODUCTION_ID,
    revision: 2,
    lastSequence: 4,
    intent: 'active',
    packageId: null,
    briefVersionId: 'av_brief',
    scriptVersionId: 'av_script_2',
    shotIds: ['shot_1', 'shot_2'],
    treatment: 'A quiet city wakes up.',
    script: 'NARRATOR: The city wakes.',
    shots: [
      shot('shot_1', { approved: true, approvedRevision: 3 }),
      shot('shot_2'),
    ],
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    production: production(),
    revision: 2,
    lastSequence: 4,
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    commandId: 'cmd_script_edit',
    idempotencyKey: 'key_script_edit',
    baseRevision: 2,
    userEventId: 'ue_user_edit',
    ...overrides,
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('readScriptCard reads the treatment, script and shot list from durable data', () => {
  const card = readScriptCard(snapshot());

  assert.equal(card.schema, SCRIPT_CARD_SCHEMA);
  assert.equal(card.kind, 'script');
  assert.equal(card.productionId, PRODUCTION_ID);
  assert.equal(card.revision, 2);
  assert.equal(card.status, 'ready');
  assert.equal(card.state, 'ready');
  assert.equal(card.stale, false);
  assert.equal(card.treatment, 'A quiet city wakes up.');
  assert.equal(card.script, 'NARRATOR: The city wakes.');
  assert.deepEqual(card.shots.map((entry) => entry.id), ['shot_1', 'shot_2']);
  assert.deepEqual(card.shots.map((entry) => entry.order), [1, 2]);
  assert.equal(card.shots[0].approved, true);
  assert.equal(card.shots[0].locked, true);
  assert.equal(card.shots[1].approved, false);
  assert.deepEqual(card.approvedShotIds, ['shot_1']);
});

test('readScriptCard reads a derived card payload and unwraps an artifact', () => {
  const card = readScriptCard({
    production: production({
      treatment: '',
      script: '',
      shots: [],
      artifacts: [
        {
          id: 'av_script_1',
          logicalId: 'lg_script',
          version: 1,
          kind: 'script',
          metadata: { treatment: 'old', script: 'old', shots: [] },
        },
        {
          id: 'av_script_2',
          logicalId: 'lg_script',
          version: 2,
          kind: 'script',
          metadata: {
            treatment: 'new treatment',
            script: 'new script',
            shots: [
              { id: 'shot_9', description: 'A new shot', state: 'approved', approved_revision: 4 },
            ],
          },
        },
      ],
    }),
    revision: 2,
    lastSequence: 4,
  });

  assert.equal(card.treatment, 'new treatment', 'the newest script artifact wins');
  assert.equal(card.script, 'new script');
  assert.equal(card.version, 2);
  assert.equal(card.logicalId, 'lg_script');
  assert.equal(card.shots[0].id, 'shot_9');
  assert.equal(card.shots[0].approved, true);
  assert.equal(card.shots[0].approvedRevision, 4);
});

test('readScriptCard prefers a derived card payload over flat production fields', () => {
  const card = readScriptCard({
    production: production({ cards: { script: { treatment: 'card treatment', script: 'card script', shots: [shot('shot_card')] } } }),
    revision: 2,
    lastSequence: 4,
  });

  assert.equal(card.treatment, 'card treatment');
  assert.equal(card.script, 'card script');
  assert.deepEqual(card.shots.map((entry) => entry.id), ['shot_card']);
});

test('readScriptCard also accepts a bare production record', () => {
  const card = readScriptCard(production());
  assert.equal(card.productionId, PRODUCTION_ID);
  assert.equal(card.revision, 2);
  assert.equal(card.status, 'ready');
  assert.equal(card.treatment, 'A quiet city wakes up.');
});

test('readScriptCard defines loading, empty, error and stale states', () => {
  assert.equal(readScriptCard(null).status, 'loading');
  assert.equal(loadingScriptCard(PRODUCTION_ID).status, 'loading');
  assert.equal(errorScriptCard('snapshot failed', PRODUCTION_ID).status, 'error');
  assert.equal(errorScriptCard('snapshot failed', PRODUCTION_ID).error, 'snapshot failed');

  const empty = readScriptCard({
    production: production({ treatment: '', script: '', shots: [], shotIds: [] }),
    revision: 2,
    lastSequence: 4,
  });
  assert.equal(empty.status, 'empty');

  const stale = readScriptCard({
    productionId: PRODUCTION_ID,
    production: production(),
    revision: 2,
    lastSequence: 4,
    stale: true,
    gap: true,
  });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.state, 'stale');
  assert.equal(stale.stale, true);
  assert.equal(stale.treatment, 'A quiet city wakes up.', 'stale still renders the last durable data');
});

test('emptyScriptCard is a defined empty state, not an exception', () => {
  const card = emptyScriptCard(PRODUCTION_ID);
  assert.equal(card.status, 'empty');
  assert.equal(card.productionId, PRODUCTION_ID);
  assert.deepEqual(card.shots, []);
  assert.equal(card.treatment, '');
  assert.equal(card.script, '');
});

test('editTreatment is an artifact.attach command with evaluate-before-write revisions', () => {
  const before = readScriptCard(snapshot());
  const frozen = plain(before);
  const result = editTreatment(before, '  A quieter city wakes up.  ', context());

  assert.equal(result.ok, true);
  assert.deepEqual(before, frozen, 'the card is not mutated in place');
  assert.equal(result.command.kind, SCRIPT_COMMAND_KIND);
  assert.equal(result.command.kind, 'artifact.attach');
  assert.equal(result.command.productionId, PRODUCTION_ID);
  assert.equal(result.command.expected.productionRevision, 2);
  assert.equal(result.command.commandId, 'cmd_script_edit');
  assert.equal(result.command.idempotencyKey, 'key_script_edit');
  assert.equal(result.command.payload.artifact.kind, SCRIPT_ARTIFACT_KIND);
  assert.equal(result.command.payload.artifact.logicalId, 'script:prod_0123456789abcdef01234567');
  assert.equal(result.command.payload.artifact.version, before.version + 1);
  assert.equal(result.command.payload.artifact.metadata.treatment, '  A quieter city wakes up.  ');
  assert.equal(result.command.payload.artifact.metadata.script, before.script);
  assert.equal(result.command.payload.edit.kind, 'treatment');
  assert.equal(result.citation, 'ue_user_edit');
  assert.equal('userEventId' in result.command, false, 'server attribution is never spoofed in the envelope');
  assert.equal('actor' in result.command, false, 'server attribution is never spoofed in the envelope');
  assert.equal(result.card.treatment, '  A quieter city wakes up.  ');
});

test('a command retry is deterministic and a changed edit is not', () => {
  const card = readScriptCard(snapshot());
  const first = editTreatment(card, 'Take one', context({ commandId: undefined, idempotencyKey: undefined }));
  const retry = editTreatment(card, 'Take one', context({ commandId: undefined, idempotencyKey: undefined }));
  const other = editTreatment(card, 'Take two', context({ commandId: undefined, idempotencyKey: undefined }));

  assert.equal(first.ok, true);
  assert.equal(retry.ok, true);
  assert.equal(first.command.commandId, retry.command.commandId);
  assert.equal(first.command.idempotencyKey, retry.command.idempotencyKey);
  assert.notEqual(first.command.commandId, other.command.commandId);
});

test('editing the script preserves every approved shot byte for byte', () => {
  const before = readScriptCard(snapshot());
  const result = editScript(before, 'NARRATOR: A new opening line.');

  assert.equal(result.ok, true);
  assert.equal(result.command.payload.edit.kind, 'script');
  assert.equal(result.command.payload.artifact.metadata.script, 'NARRATOR: A new opening line.');
  assert.deepEqual(result.command.payload.artifact.metadata.shots, before.shots.map((entry) => ({
    id: entry.id,
    order: entry.order,
    title: entry.title,
    description: entry.description,
    dialogue: entry.dialogue,
    durationSeconds: entry.durationSeconds,
    approved: entry.approved,
    approvedRevision: entry.approvedRevision,
  })));
  assert.deepEqual(result.command.payload.artifact.metadata.approvedShotIds, ['shot_1']);
  assert.deepEqual(result.card.shots, before.shots);
});

test('unknown durable fields on an approved shot survive a prose edit', () => {
  const card = readScriptCard(snapshot({
    production: production({
      shots: [
        shot('shot_1', { approved: true, approvedRevision: 3, prompt: 'keep this conditioning prompt' }),
        shot('shot_2'),
      ],
    }),
  }));
  const result = editScript(card, 'A new script line.');

  assert.equal(result.ok, true);
  assert.equal(result.command.payload.artifact.metadata.shots[0].prompt, 'keep this conditioning prompt');
  assert.equal(result.card.shots[0].prompt, 'keep this conditioning prompt');
  assert.equal(result.card.shots[0].approved, true);
});

test('an approved shot is locked against edits', () => {
  const card = readScriptCard(snapshot());
  assert.equal(isShotLocked(card, 'shot_1'), true);
  assert.equal(isShotLocked(card, 'shot_2'), false);

  const result = editShot(card, 'shot_1', { description: 'Rewritten' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SHOT_LOCKED');
  assert.equal(result.card.shots[0].description, shot('shot_1').description);
});

test('an unapproved shot edits normally and keeps approved shots untouched', () => {
  const before = readScriptCard(snapshot());
  const result = editShot(before, 'shot_2', {
    title: 'New title',
    description: 'New action',
    dialogue: 'Hello.',
    durationSeconds: 4.5,
  }, context({ commandId: 'cmd_shot_edit' }));

  assert.equal(result.ok, true);
  assert.equal(result.command.payload.edit.kind, 'shot');
  assert.equal(result.command.payload.edit.shotId, 'shot_2');
  assert.equal(result.command.payload.artifact.metadata.shots[1].title, 'New title');
  assert.equal(result.command.payload.artifact.metadata.shots[1].durationSeconds, 4.5);
  assert.deepEqual(result.command.payload.artifact.metadata.shots[0], {
    id: 'shot_1',
    order: 1,
    title: 'Shot shot_1',
    description: 'Action for shot_1',
    dialogue: '',
    durationSeconds: null,
    approved: true,
    approvedRevision: 3,
  });
  assert.deepEqual(result.card.shots[0], before.shots[0]);
});

test('a no-op or malformed edit does not create a command', () => {
  const card = readScriptCard(snapshot());
  assert.equal(editTreatment(card, card.treatment).ok, false);
  assert.equal(editTreatment(card, card.treatment).code, 'NO_CHANGE');
  assert.equal(editScript(card, 42).ok, false);
  assert.equal(editShot(card, 'shot_2', {}).ok, false);
  assert.equal(editShot(card, 'shot_2', { unknown: true }).ok, false);
  assert.equal(editShot(card, 'shot_missing', { title: 'x' }).code, 'UNKNOWN_SHOT');
});

test('removeShot refuses approved shots and compacts the remaining order', () => {
  const card = readScriptCard(snapshot());
  const locked = removeShot(card, 'shot_1');
  assert.equal(locked.ok, false);
  assert.equal(locked.code, 'SHOT_LOCKED');

  const removed = removeShot(card, 'shot_2');
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.card.shots.map((entry) => entry.id), ['shot_1']);
  assert.deepEqual(removed.command.payload.artifact.metadata.shots.map((entry) => entry.id), ['shot_1']);
});

test('addShot appends after approved shots with a collision-free temporary id', () => {
  const card = readScriptCard(snapshot({ production: production({ shots: [shot('shot_1', { approved: true }), shot('shot_3')] }) }));
  const result = addShot(card, { title: 'Insert', description: 'A new beat' });

  assert.equal(result.ok, true);
  assert.equal(result.card.shots.length, 3);
  assert.equal(result.card.shots[2].id, 'shot_2');
  assert.equal(result.card.shots[2].order, 3);
  assert.equal(result.card.shots[0].approved, true);
  assert.equal(result.command.payload.edit.kind, 'shot.add');
});

test('reorderShots cannot move an approved shot', () => {
  const card = readScriptCard(snapshot());
  const blocked = reorderShots(card, ['shot_2', 'shot_1']);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'SHOT_LOCKED');

  const open = readScriptCard(snapshot({
    production: production({ shots: [shot('shot_1'), shot('shot_2')] }),
  }));
  const moved = reorderShots(open, ['shot_2', 'shot_1']);
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.card.shots.map((entry) => entry.id), ['shot_2', 'shot_1']);
  assert.deepEqual(moved.card.shots.map((entry) => entry.order), [1, 2]);
});

test('reorderShots rejects missing, duplicate or unknown ids without a command', () => {
  const card = readScriptCard(snapshot({
    production: production({ shots: [shot('shot_1'), shot('shot_2')] }),
  }));
  assert.equal(reorderShots(card, ['shot_1']).code, 'INVALID_ORDER');
  assert.equal(reorderShots(card, ['shot_1', 'shot_1']).code, 'INVALID_ORDER');
  assert.equal(reorderShots(card, ['shot_1', 'shot_other']).code, 'INVALID_ORDER');
});

test('a stale card and a loading card refuse edits', () => {
  const stale = readScriptCard({
    productionId: PRODUCTION_ID,
    production: production(),
    revision: 2,
    lastSequence: 4,
    stale: true,
  });
  assert.equal(editTreatment(stale, 'new').code, 'STALE_VIEW');

  const loading = loadingScriptCard(PRODUCTION_ID);
  assert.equal(editTreatment(loading, 'new').code, 'NOT_READY');
});

test('a base revision that does not match the card is refused', () => {
  const card = readScriptCard(snapshot());
  const result = editTreatment(card, 'new', context({ baseRevision: 7 }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'REVISION_MISMATCH');
});

test('renderScriptCard renders safe, durable data with locked approved shots', () => {
  const card = readScriptCard(snapshot());
  card.treatment = '<b>bold</b> & ready';
  const html = renderScriptCard(card);

  assert.match(html, /data-script-card/);
  assert.match(html, /data-card-status="ready"/);
  assert.match(html, /data-script-treatment/);
  assert.match(html, /data-script-body/);
  assert.match(html, /data-script-shots/);
  assert.match(html, /data-shot-id="shot_1"/);
  assert.match(html, /data-shot-approved="true"/);
  assert.match(html, /data-shot-locked="true"/);
  assert.match(html, /readonly/);
  assert.match(html, /aria-readonly="true"/);
  assert.match(html, /Approved · locked/);
  assert.match(html, /&lt;b&gt;bold&lt;\/b&gt; &amp; ready/);
  assert.equal(html.includes('<b>bold</b>'), false, 'card data is escaped, never injected as HTML');
  assert.equal(html.includes('data-revision="2"'), true);
  assert.equal(html.includes('data-version="1"'), true);
});

test('renderScriptCard defines loading, empty, error and stale states', () => {
  const loading = renderScriptCard(loadingScriptCard(PRODUCTION_ID));
  assert.match(loading, /data-card-status="loading"/);
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /Loading the script/);

  const empty = renderScriptCard(emptyScriptCard(PRODUCTION_ID));
  assert.match(empty, /data-card-status="empty"/);
  assert.match(empty, /No treatment or script yet/);

  const error = renderScriptCard(errorScriptCard('snapshot failed', PRODUCTION_ID));
  assert.match(error, /data-card-status="error"/);
  assert.match(error, /role="alert"/);
  assert.match(error, /snapshot failed/);

  const stale = renderScriptCard(readScriptCard({
    productionId: PRODUCTION_ID,
    production: production(),
    revision: 2,
    lastSequence: 4,
    stale: true,
  }));
  assert.match(stale, /data-card-status="stale"/);
  assert.match(stale, /data-card-stale="true"/);
  assert.match(stale, /This card is behind the event journal/);
  assert.match(stale, /disabled/, 'a stale card never looks editable');
});

test('sendScriptEdit sends the built command through the one command client', async () => {
  const sent = [];
  const result = editTreatment(readScriptCard(snapshot()), 'Fresh treatment', context());
  const response = await sendScriptEdit({
    async sendCommand(envelope) {
      sent.push(envelope);
      return { ok: true };
    },
  }, result);

  assert.deepEqual(response, { ok: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'artifact.attach');
  assert.equal(sent[0].payload.artifact.metadata.treatment, 'Fresh treatment');

  await assert.rejects(
    () => sendScriptEdit({ async sendCommand() { throw new Error('must not be called'); } }, removeShot(readScriptCard(snapshot()), 'shot_1')),
    /SHOT_LOCKED/,
  );
});

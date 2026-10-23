// IP33: pause/resume/cancel controls for a production, plus honest teardown.
//
// The card is a view of the IP28 snapshot and journal. The snapshot's
// `production.intent` is the only durable production status; a journal event
// may override it only when that event is newer than the snapshot. Teardown
// comes from exactly one explicit record, never from a status-shaped field.
// Tests use pure functions and a fake client: no network, Google Colab session
// or paid backend is involved.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import * as progress from '../src/productions/cards/progress.ts';
import {
  buildProgressControlCommand,
  readProgressControls,
  renderProgressControls,
  sendProgressControl,
} from '../src/productions/cards/progress.ts';

const PRODUCTION_ID = 'prod_0123456789abcdef01234567';

function snapshot(overrides = {}) {
  return {
    production: { id: PRODUCTION_ID, intent: 'active', ...(overrides.production ?? {}) },
    revision: 9,
    lastSequence: 9,
    events: [],
    pendingActions: [],
    ...overrides,
  };
}

function control(card, name) {
  return card.controls[name];
}

test('the snapshot intent wins over an older journal event', () => {
  const card = readProgressControls(snapshot({
    events: [
      { sequence: 3, type: 'production.intent_changed', data: { intent: 'paused' } },
    ],
  }));

  assert.equal(card.intent, 'active');
  assert.equal(control(card, 'pause').enabled, true);
  assert.equal(control(card, 'resume').enabled, false);
  assert.equal(control(card, 'cancel').enabled, true);
});

test('a journal event newer than the snapshot overrides the snapshot intent', () => {
  const card = readProgressControls(snapshot({
    lastSequence: 9,
    events: [
      { sequence: 10, type: 'production.intent_changed', data: { intent: 'paused' } },
    ],
  }));

  assert.equal(card.intent, 'paused');
  assert.equal(control(card, 'pause').enabled, false);
  assert.equal(control(card, 'resume').enabled, true);
});

test('a missing snapshot revision is NOT_READY, never revision zero', () => {
  const card = readProgressControls({ production: { id: PRODUCTION_ID, intent: 'active' } });

  assert.equal(card.revision, null);
  assert.equal(card.intent, 'unknown');
  assert.equal(card.controls.pause.enabled, false);
  assert.equal(card.controls.resume.enabled, false);
  assert.equal(card.controls.cancel.enabled, false);

  const result = buildProgressControlCommand(card, 'pause');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOT_READY');
  assert.equal('command' in result, false);
});

test('intent is read only from production.intent, not a status-shaped field', () => {
  for (const production of [
    { id: PRODUCTION_ID, status: 'running' },
    { id: PRODUCTION_ID, status: 'active' },
    { id: PRODUCTION_ID, state: 'paused' },
    { id: PRODUCTION_ID, intent: 'running' },
  ]) {
    const card = readProgressControls({ production, revision: 4, lastSequence: 4 });
    assert.equal(card.intent, 'unknown', JSON.stringify(production));
    assert.equal(card.controls.pause.enabled, false);
    assert.equal(card.controls.resume.enabled, false);
    assert.equal(card.controls.cancel.enabled, false);
  }
});

test('the four contract intents are the closed vocabulary', () => {
  for (const intent of ['active', 'paused', 'cancel_requested', 'archived']) {
    const card = readProgressControls({ production: { id: PRODUCTION_ID, intent }, revision: 2 });
    assert.equal(card.intent, intent);
  }
});

test('teardown is not inferred from production.status', () => {
  const card = readProgressControls(snapshot({ production: { id: PRODUCTION_ID, intent: 'active', status: 'idle' } }));
  assert.equal(card.teardown, null);

  const html = renderProgressControls(card);
  assert.doesNotMatch(html, /data-progress-teardown/);
  assert.doesNotMatch(html, /idle/);
});

test('stop_unconfirmed is shown as shutdown_unconfirmed with its evidence', () => {
  const card = readProgressControls(snapshot(), {
    teardown: { state: 'stop_unconfirmed', evidence: 'Google Colab session still listed' },
  });

  assert.equal(card.teardown.state, 'shutdown_unconfirmed');
  assert.equal(card.teardown.evidence, 'Google Colab session still listed');

  const html = renderProgressControls(card);
  assert.match(html, /data-progress-teardown/);
  assert.match(html, /data-progress-teardown-state="shutdown_unconfirmed"/);
  assert.match(html, /shutdown unconfirmed/i);
  assert.match(html, /Google Colab session still listed/);
});

test('an unconfirmed pending action wins over a stopped teardown record', () => {
  const card = readProgressControls(snapshot({
    pendingActions: [
      { id: 'act_1', state: 'completed' },
      { id: 'act_2', state: 'submission_unknown', status: 'shutdown_unconfirmed' },
    ],
  }), {
    teardown: { state: 'stopped', evidence: 'VM stopped' },
  });

  assert.equal(card.teardown.state, 'shutdown_unconfirmed');
});

test('remaining active work counts pending actions that are not terminal', () => {
  const card = readProgressControls(snapshot({
    pendingActions: [
      { id: 'act_1', state: 'queued' },
      { id: 'act_2', state: 'running' },
      { id: 'act_3', state: 'completed' },
      { id: 'act_4', state: 'failed' },
      { id: 'act_5', state: 'cancelled' },
      { id: 'act_6', state: 'interrupted' },
      { id: 'act_7', state: 'submission_unknown' },
    ],
  }));

  // interrupted and submission_unknown still need reconciliation (may hold compute).
  assert.equal(card.remainingWork, 4);
  const html = renderProgressControls(card);
  assert.match(html, /data-progress-remaining-work/);
  assert.match(html, /4 actions still active/);
});

test('a cancel command is deterministic from production, revision and kind', () => {
  const card = readProgressControls(snapshot());

  const first = buildProgressControlCommand(card, 'cancel');
  const retry = buildProgressControlCommand(card, 'cancel');
  const pause = buildProgressControlCommand(card, 'pause');
  const otherRevision = buildProgressControlCommand(readProgressControls(snapshot({ revision: 10 })), 'cancel');

  assert.equal(first.ok, true);
  assert.equal(retry.ok, true);
  assert.equal(first.command.commandId, retry.command.commandId);
  assert.equal(first.command.idempotencyKey, retry.command.idempotencyKey);
  assert.notEqual(first.command.commandId, pause.command.commandId);
  assert.notEqual(first.command.commandId, otherRevision.command.commandId);
  assert.equal(first.command.kind, 'production.cancel');
  assert.equal(pause.command.kind, 'production.pause');
  assert.deepEqual(first.command.expected, { productionRevision: 9 });
});

test('the one closed command vocabulary is pause, resume and cancel', () => {
  const active = readProgressControls(snapshot());
  assert.equal(buildProgressControlCommand(active, 'resume').code, 'NOT_AVAILABLE');
  assert.equal(buildProgressControlCommand(active, 'pause').command.kind, 'production.pause');
  assert.equal(buildProgressControlCommand(active, 'cancel').command.kind, 'production.cancel');

  const paused = readProgressControls(snapshot({ production: { id: PRODUCTION_ID, intent: 'paused' } }));
  assert.equal(buildProgressControlCommand(paused, 'pause').code, 'NOT_AVAILABLE');
  assert.equal(buildProgressControlCommand(paused, 'resume').command.kind, 'production.resume');

  for (const intent of ['cancel_requested', 'archived']) {
    const card = readProgressControls({ production: { id: PRODUCTION_ID, intent }, revision: 3 });
    for (const name of ['pause', 'resume', 'cancel']) {
      assert.equal(buildProgressControlCommand(card, name).code, 'NOT_AVAILABLE', `${intent} ${name}`);
    }
  }

  const unknown = readProgressControls({ production: { id: PRODUCTION_ID, intent: 'bogus' }, revision: 3 });
  assert.equal(buildProgressControlCommand(unknown, 'pause').code, 'NOT_READY');

  assert.equal(buildProgressControlCommand(active, 'archive').code, 'NOT_AVAILABLE');
});

test('a stale card refuses with STALE_VIEW and a mismatched base revision with REVISION_MISMATCH', () => {
  const stale = readProgressControls(snapshot({ stale: true }));
  const staleResult = buildProgressControlCommand(stale, 'pause');
  assert.equal(staleResult.ok, false);
  assert.equal(staleResult.code, 'STALE_VIEW');
  assert.equal('command' in staleResult, false);

  const card = readProgressControls(snapshot());
  const mismatch = buildProgressControlCommand(card, 'pause', { baseRevision: 8 });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'REVISION_MISMATCH');
  assert.equal('command' in mismatch, false);
});

test('cancel copy keeps collected takes and escapes durable values', () => {
  const card = readProgressControls(snapshot({
    collectedTakeIds: ['take_<1>', 'take_&2'],
  }));

  assert.deepEqual(card.collectedTakeIds, ['take_<1>', 'take_&2']);
  const html = renderProgressControls(card);
  assert.match(html, /Collected takes are kept/);
  assert.match(html, /data-progress-control="cancel"/);
  assert.match(html, /data-collected-take-id="take_&lt;1&gt;"/);
  assert.doesNotMatch(html, /take_<1>/);
});

test('evidence and other durable text are escaped in markup', () => {
  const card = readProgressControls({
    production: { id: 'prod_<1>', intent: 'active' },
    revision: 1,
  }, {
    teardown: { state: 'stop_unconfirmed', evidence: 'session <still> & listed' },
  });

  const html = renderProgressControls(card);
  assert.match(html, /prod_&lt;1&gt;/);
  assert.match(html, /session &lt;still&gt; &amp; listed/);
  assert.doesNotMatch(html, /<still>/);
});

test('sendProgressControl sends only an accepted command', async () => {
  const sent = [];
  const card = readProgressControls(snapshot());
  const result = buildProgressControlCommand(card, 'pause');
  const response = await sendProgressControl({
    async sendCommand(envelope) {
      sent.push(envelope);
      return { ok: true };
    },
  }, result);

  assert.deepEqual(response, { ok: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'production.pause');

  await assert.rejects(
    () => sendProgressControl(
      { async sendCommand() { throw new Error('must not be called'); } },
      buildProgressControlCommand(card, 'resume'),
    ),
    /NOT_AVAILABLE/,
  );
});

test('the removed aliases are not exported', () => {
  assert.equal(progress.progressControls, undefined);
  assert.equal(progress.progressControlCommand, undefined);
  assert.equal(progress.sendProgressCommand, undefined);
});

test('loading and malformed input never render an actionable control', () => {
  for (const input of [null, undefined, {}, { production: null }, { production: { id: PRODUCTION_ID } }]) {
    const card = readProgressControls(input);
    assert.equal(card.intent, 'unknown');
    assert.equal(card.controls.pause.enabled, false);
    assert.equal(card.controls.resume.enabled, false);
    assert.equal(card.controls.cancel.enabled, false);
  }

  const html = renderProgressControls(readProgressControls(null));
  assert.match(html, /data-progress-control="pause"[^>]*disabled/);
  assert.match(html, /data-progress-control="resume"[^>]*disabled/);
  assert.match(html, /data-progress-control="cancel"[^>]*disabled/);
});
